// Fraud engine: Kafka consumer group "fraud-engine" on pos.transactions.
// Scores each transaction against the enabled rules, writes alerts and card blocks,
// and publishes them to pos.fraud.alerts.
//
// Idempotent: a transaction is scored once (fraud_scored_txns primary key), and alerts
// are unique per (rule, transaction), so Kafka redeliveries can't double-alert.

const { evaluate } = require('./rules');
const { withTx, loadRules } = require('./db');

function log(msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'fraud-engine', msg, ...(extra || {}) }));
}

async function scoreEvent(e) {
  return withTx(async (c) => {
    const first = await c.query(
      `INSERT INTO fraud_scored_txns (transaction_id, card_masked, merchant_id, txn_time)
       VALUES ($1,$2,$3,$4) ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
      [e.transaction_id, e.card_masked, e.merchant_id, e.txn_time]
    );
    if (first.rowCount === 0) {
      // Already scored (Kafka redelivery). Re-publish its alerts in case the earlier
      // attempt crashed after the DB commit but before publishing (at-least-once).
      const prev = await c.query('SELECT * FROM fraud_alerts WHERE transaction_id = $1', [e.transaction_id]);
      return { skipped: true, published: prev.rows.map((r) => ({ event_type: 'fraud.alert.created', ...r })) };
    }

    const rules = await loadRules(c);
    let velocityCount = 0;
    if (rules.VELOCITY) {
      const r = await c.query(
        `SELECT COUNT(*)::int AS n FROM fraud_scored_txns
         WHERE card_masked = $1 AND merchant_id IS NOT DISTINCT FROM $2
           AND txn_time >  $3::timestamptz - make_interval(secs => $4)
           AND txn_time <= $3::timestamptz`,
        [e.card_masked, e.merchant_id, e.txn_time, Number(rules.VELOCITY.params.window_seconds)]
      );
      velocityCount = r.rows[0].n;
    }
    const blk = await c.query('SELECT 1 FROM card_blocks WHERE card_masked = $1 AND active', [e.card_masked]);

    const candidates = evaluate(e, rules, { velocityCount, cardBlocked: blk.rowCount > 0 });
    const published = [];

    for (const a of candidates) {
      if (a.dedupSeconds > 0) {
        const dup = await c.query(
          `SELECT alert_id FROM fraud_alerts
           WHERE rule_id = $1 AND card_masked = $2 AND status = 'OPEN'
             AND ($3::boolean = false OR merchant_id IS NOT DISTINCT FROM $4)
             AND created_at > now() - make_interval(secs => $5)
           LIMIT 1`,
          [a.rule_id, e.card_masked, !!a.dedupByMerchant, e.merchant_id, a.dedupSeconds]
        );
        if (dup.rowCount > 0) continue; // an open alert already covers this pattern
      }

      const ins = await c.query(
        `INSERT INTO fraud_alerts (rule_id, severity, transaction_id, card_masked, merchant_id, amount, txn_status, response_code, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (rule_id, transaction_id) DO NOTHING RETURNING *`,
        [a.rule_id, a.severity, e.transaction_id, e.card_masked, e.merchant_id, e.amount, e.status, e.response_code, a.detail]
      );
      if (ins.rowCount) published.push({ event_type: 'fraud.alert.created', ...ins.rows[0] });

      if (a.block) {
        const b = await c.query(
          `INSERT INTO card_blocks (card_masked, reason, source) VALUES ($1,$2,$3)
           ON CONFLICT (card_masked) WHERE active DO NOTHING RETURNING *`,
          [e.card_masked, a.detail, `rule:${a.rule_id}`]
        );
        if (b.rowCount) published.push({ event_type: 'card.blocked', ...b.rows[0] });
      }
    }
    return { skipped: false, published };
  });
}

async function startEngine(kafka, publish, topic) {
  const consumer = kafka.consumer({ groupId: 'fraud-engine' });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message, heartbeat }) => {
      const e = JSON.parse(message.value.toString());
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await scoreEvent(e);
          for (const ev of r.published) await publish('pos.fraud.alerts', ev.card_masked, ev);
          if (r.published.length) log('alerts', { id: e.transaction_id, events: r.published.map((p) => p.rule_id || p.event_type) });
          return;
        } catch (err) {
          if (attempt === 1 || attempt % 10 === 0) log('scoring failed, retrying', { attempt, error: err.message });
          await new Promise((res) => setTimeout(res, 3000));
          await heartbeat();
        }
      }
    },
  });
  log('consumer started', { groupId: 'fraud-engine', topic });
  return consumer;
}

module.exports = { startEngine, scoreEvent };
