// Risk API: fraud alerts, card blocks, rules, and disputes / chargebacks.
// Mounted at /api by server.js. Every state change is also published to Kafka.

const express = require('express');
const { pool, withTx, normalizeCard } = require('./db');
const { validateRuleUpdate } = require('./rules');
const fsm = require('./fsm');

const DISPUTE_WINDOW_DAYS = 120;

function buildApi(publish) {
  const r = express.Router();
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
  const addDays = (n) => (n ? new Date(Date.now() + n * 86400000).toISOString().slice(0, 10) : null);

  // ---------- health / summary ----------
  r.get('/health', wrap(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  }));

  r.get('/summary', wrap(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM fraud_alerts WHERE status = 'OPEN')::int                         AS open_alerts,
        (SELECT COUNT(*) FROM fraud_alerts WHERE status = 'OPEN' AND severity = 'critical')::int AS critical_alerts,
        (SELECT COUNT(*) FROM card_blocks WHERE active)::int                                    AS active_blocks,
        (SELECT COUNT(*) FROM disputes WHERE closed_at IS NULL)::int                            AS open_disputes,
        (SELECT COALESCE(SUM(dispute_amount),0) FROM disputes WHERE closed_at IS NULL)::numeric AS open_dispute_amount`);
    res.json(rows[0]);
  }));

  // ---------- rules ----------
  r.get('/fraud/rules', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM fraud_rules ORDER BY rule_id');
    res.json({ rules: rows });
  }));

  r.put('/fraud/rules/:id', wrap(async (req, res) => {
    const cur = await pool.query('SELECT * FROM fraud_rules WHERE rule_id = $1', [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'rule not found' });
    const err = validateRuleUpdate(req.params.id, req.body || {});
    if (err) return res.status(422).json({ error: err });
    const b = req.body;
    const params = b.params ? { ...cur.rows[0].params, ...b.params } : cur.rows[0].params;
    const { rows } = await pool.query(
      `UPDATE fraud_rules SET enabled = COALESCE($2, enabled), severity = COALESCE($3, severity),
              params = $4, updated_at = now() WHERE rule_id = $1 RETURNING *`,
      [req.params.id, b.enabled ?? null, b.severity ?? null, params]
    );
    res.json(rows[0]);
  }));

  // ---------- alerts ----------
  r.get('/fraud/alerts', wrap(async (req, res) => {
    const { status, rule_id, card } = req.query;
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const { rows } = await pool.query(
      `SELECT * FROM fraud_alerts
       WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR rule_id = $2) AND ($3::text IS NULL OR card_masked = $3)
       ORDER BY alert_id DESC LIMIT $4`,
      [status || null, rule_id || null, card ? normalizeCard(card) : null, limit]
    );
    res.json({ alerts: rows });
  }));

  r.get('/fraud/alerts/:id', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM fraud_alerts WHERE alert_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'alert not found' });
    res.json(rows[0]);
  }));

  // Analyst review. CONFIRMED_FRAUD on an approved transaction files a fraud chargeback.
  r.post('/fraud/alerts/:id/review', wrap(async (req, res) => {
    const { decision, analyst = 'analyst', note = null } = req.body || {};
    if (!['CONFIRMED_FRAUD', 'FALSE_POSITIVE'].includes(decision)) {
      return res.status(422).json({ error: "decision must be 'CONFIRMED_FRAUD' or 'FALSE_POSITIVE'" });
    }
    const out = await withTx(async (c) => {
      const a = await c.query('SELECT * FROM fraud_alerts WHERE alert_id = $1 FOR UPDATE', [req.params.id]);
      if (!a.rowCount) return { status: 404, body: { error: 'alert not found' } };
      const alert = a.rows[0];
      if (alert.status !== 'OPEN') return { status: 409, body: { error: `alert already reviewed (${alert.status})` } };

      let dispute = null;
      let disputeNote = null;
      if (decision === 'CONFIRMED_FRAUD') {
        if (alert.txn_status !== 'APPROVED') {
          disputeNote = 'no chargeback: transaction was not approved, so no funds moved';
        } else {
          const filed = await fileDispute(c, {
            transaction_id: alert.transaction_id,
            category: 'fraud',
            note: `Confirmed fraud from alert #${alert.alert_id} (${alert.rule_id})`,
            source: `fraud_alert:${alert.alert_id}`,
          });
          if (filed.status === 201) dispute = filed.body;
          else disputeNote = `no chargeback: ${filed.body.error}`;
        }
      }
      const upd = await c.query(
        `UPDATE fraud_alerts SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4, dispute_id = $5
         WHERE alert_id = $1 RETURNING *`,
        [alert.alert_id, decision, analyst, note, dispute ? dispute.dispute_id : null]
      );
      return { status: 200, body: { alert: upd.rows[0], dispute, dispute_note: disputeNote } };
    });
    if (out.status === 200) {
      await publish('pos.fraud.alerts', out.body.alert.card_masked, { event_type: 'fraud.alert.reviewed', ...out.body.alert });
      if (out.body.dispute) await publishDispute(out.body.dispute, 'file_chargeback', null, 'issuer', out.body.alert.review_note);
    }
    res.status(out.status).json(out.body);
  }));

  // ---------- card blocks ----------
  r.get('/cards/blocks', wrap(async (req, res) => {
    const active = req.query.active === undefined ? null : req.query.active === 'true';
    const { rows } = await pool.query(
      'SELECT * FROM card_blocks WHERE ($1::boolean IS NULL OR active = $1) ORDER BY block_id DESC LIMIT 200', [active]);
    res.json({ blocks: rows });
  }));

  r.post('/cards/blocks', wrap(async (req, res) => {
    const card = normalizeCard(req.body && req.body.card);
    const reason = req.body && String(req.body.reason || '').trim();
    if (!card) return res.status(422).json({ error: "card is required (last 4 digits, e.g. '1117' or '•••• 1117')" });
    if (!reason) return res.status(422).json({ error: 'reason is required' });
    const { rows } = await pool.query(
      `INSERT INTO card_blocks (card_masked, reason, source) VALUES ($1,$2,$3)
       ON CONFLICT (card_masked) WHERE active DO NOTHING RETURNING *`,
      [card, reason, `analyst:${req.body.analyst || 'analyst'}`]
    );
    if (!rows.length) return res.status(409).json({ error: `${card} already has an active block` });
    await publish('pos.fraud.alerts', card, { event_type: 'card.blocked', ...rows[0] });
    res.status(201).json(rows[0]);
  }));

  r.post('/cards/blocks/:id/release', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE card_blocks SET active = false, released_at = now(), released_by = $2
       WHERE block_id = $1 AND active RETURNING *`,
      [req.params.id, (req.body && req.body.analyst) || 'analyst']
    );
    if (!rows.length) return res.status(409).json({ error: 'block not found or already released' });
    await publish('pos.fraud.alerts', rows[0].card_masked, { event_type: 'card.unblocked', ...rows[0] });
    res.json(rows[0]);
  }));

  // ---------- disputes ----------
  r.get('/disputes/reason-codes', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM chargeback_reason_codes WHERE ($1::text IS NULL OR network = $1) ORDER BY network, category, code',
      [req.query.network ? String(req.query.network).toUpperCase() : null]);
    res.json({ reason_codes: rows });
  }));

  r.get('/disputes', wrap(async (req, res) => {
    const open = req.query.open === undefined ? null : req.query.open === 'true';
    const { rows } = await pool.query(
      `SELECT d.*, rc.description AS reason_description, rc.category AS reason_category
       FROM disputes d JOIN chargeback_reason_codes rc ON rc.network = d.network AND rc.code = d.reason_code
       WHERE ($1::text IS NULL OR d.state = $1)
         AND ($2::boolean IS NULL OR (d.closed_at IS NULL) = $2)
       ORDER BY d.dispute_id DESC LIMIT 200`,
      [req.query.state || null, open]);
    res.json({ disputes: rows.map((d) => ({ ...d, allowed_actions: fsm.allowedActions(d.state) })) });
  }));

  r.get('/disputes/:id', wrap(async (req, res) => {
    const d = await pool.query(
      `SELECT d.*, rc.description AS reason_description, rc.category AS reason_category
       FROM disputes d JOIN chargeback_reason_codes rc ON rc.network = d.network AND rc.code = d.reason_code
       WHERE d.dispute_id = $1`, [req.params.id]);
    if (!d.rowCount) return res.status(404).json({ error: 'dispute not found' });
    const ev = await pool.query('SELECT * FROM dispute_events WHERE dispute_id = $1 ORDER BY event_id', [req.params.id]);
    res.json({ ...d.rows[0], allowed_actions: fsm.allowedActions(d.rows[0].state), events: ev.rows });
  }));

  r.post('/disputes', wrap(async (req, res) => {
    const b = req.body || {};
    const out = await withTx((c) => fileDispute(c, {
      transaction_id: b.transaction_id, reason_code: b.reason_code, amount: b.amount, note: b.note || null, source: 'cardholder',
    }));
    if (out.status === 201) await publishDispute(out.body, 'file_chargeback', null, 'issuer', b.note || null);
    res.status(out.status).json(out.body);
  }));

  r.post('/disputes/:id/actions', wrap(async (req, res) => {
    const { action, note = null } = req.body || {};
    const out = await withTx(async (c) => {
      const d = await c.query('SELECT * FROM disputes WHERE dispute_id = $1 FOR UPDATE', [req.params.id]);
      if (!d.rowCount) return { status: 404, body: { error: 'dispute not found' } };
      const cur = d.rows[0];
      const t = fsm.applyAction(cur.state, action, note);
      if (!t.ok) return { status: t.status, body: { error: t.error, state: cur.state, allowed_actions: t.allowed } };

      const upd = await c.query(
        `UPDATE disputes SET state = $2, updated_at = now(), respond_by = $3,
                closed_at = CASE WHEN $4 THEN now() ELSE NULL END,
                liability = COALESCE($5, liability),
                provisional_credit = COALESCE($6, provisional_credit)
         WHERE dispute_id = $1 RETURNING *`,
        [cur.dispute_id, t.to, addDays(t.respondDays), t.closed, t.liability || null, t.provisional_credit ?? null]
      );
      await c.query(
        'INSERT INTO dispute_events (dispute_id, action, from_state, to_state, actor, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [cur.dispute_id, action, t.from, t.to, t.actor, note]
      );
      return { status: 200, body: { ...upd.rows[0], allowed_actions: fsm.allowedActions(t.to) }, t };
    });
    if (out.status === 200) await publishDispute(out.body, action, out.t.from, out.t.actor, note);
    res.status(out.status).json(out.body);
  }));

  // ---------- helpers ----------
  // Shared by the dispute API and fraud review. Runs inside the caller's transaction.
  async function fileDispute(c, { transaction_id, reason_code, amount, note, source, category }) {
    if (!transaction_id) return { status: 422, body: { error: 'transaction_id is required' } };
    const t = await c.query('SELECT * FROM card_transactions WHERE id = $1', [transaction_id]);
    if (!t.rowCount) return { status: 404, body: { error: 'transaction not found in card_transactions (has the pipeline loaded it yet?)' } };
    const txn = t.rows[0];
    if (txn.status !== 'APPROVED') {
      return { status: 422, body: { error: `only APPROVED transactions can be charged back (this one is ${txn.status} ${txn.response_code})` } };
    }
    const ageDays = (Date.now() - new Date(txn.txn_time).getTime()) / 86400000;
    if (ageDays > DISPUTE_WINDOW_DAYS) {
      return { status: 422, body: { error: `outside the ${DISPUTE_WINDOW_DAYS}-day dispute window (${Math.floor(ageDays)} days old)` } };
    }

    const network = txn.card_brand;
    let code = reason_code;
    if (!code && category) {
      const rc = await c.query('SELECT code FROM chargeback_reason_codes WHERE network = $1 AND category = $2 ORDER BY code LIMIT 1', [network, category]);
      code = rc.rows[0] && rc.rows[0].code;
    }
    const rc = await c.query('SELECT * FROM chargeback_reason_codes WHERE network = $1 AND code = $2', [network, code]);
    if (!rc.rowCount) {
      return { status: 422, body: { error: `reason code '${code}' is not valid for ${network}` } };
    }

    const txnAmount = Number(txn.amount);
    const disputeAmount = amount === undefined || amount === null || amount === '' ? txnAmount : Number(amount);
    if (!(disputeAmount > 0) || disputeAmount > txnAmount) {
      return { status: 422, body: { error: `dispute amount must be greater than 0 and no more than the transaction amount ($${txnAmount.toFixed(2)})` } };
    }

    const open = await c.query('SELECT dispute_id, state FROM disputes WHERE transaction_id = $1 AND closed_at IS NULL', [transaction_id]);
    if (open.rowCount) {
      return { status: 409, body: { error: `transaction already has an open dispute (#${open.rows[0].dispute_id}, ${open.rows[0].state})` } };
    }

    const d = await c.query(
      `INSERT INTO disputes (transaction_id, card_masked, card_brand, merchant_id, txn_amount, dispute_amount,
                             network, reason_code, state, source, respond_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [txn.id, txn.card_masked, txn.card_brand, txn.merchant_id, txnAmount, disputeAmount,
       network, code, fsm.INITIAL.state, source, addDays(fsm.INITIAL.respondDays)]
    );
    await c.query(
      'INSERT INTO dispute_events (dispute_id, action, from_state, to_state, actor, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [d.rows[0].dispute_id, 'file_chargeback', null, fsm.INITIAL.state, fsm.INITIAL.actor, note]
    );
    return {
      status: 201,
      body: { ...d.rows[0], reason_description: rc.rows[0].description, reason_category: rc.rows[0].category, allowed_actions: fsm.allowedActions(fsm.INITIAL.state) },
    };
  }

  async function publishDispute(d, action, fromState, actor, note) {
    await publish('pos.disputes', d.card_masked, {
      event_type: 'dispute.event', action, from_state: fromState, to_state: d.state, actor, note,
      dispute_id: d.dispute_id, transaction_id: d.transaction_id, card_masked: d.card_masked, card_brand: d.card_brand,
      merchant_id: d.merchant_id, network: d.network, reason_code: d.reason_code,
      dispute_amount: Number(d.dispute_amount), liability: d.liability, provisional_credit: d.provisional_credit,
      event_time: new Date().toISOString(),
    });
  }

  return r;
}

module.exports = { buildApi };
