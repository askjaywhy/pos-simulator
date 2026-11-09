// tx-sinks: two independent Kafka consumer groups reading pos.transactions.
//   postgres-sink -> upserts into card_transactions
//   splunk-sink   -> sends each event to Splunk HEC (sourcetype pos:transaction)
//
// Separate groups = each sink gets every message and tracks its own offsets,
// so Splunk being slow to boot never holds up Postgres (and vice versa).

const { Kafka, logLevel } = require('kafkajs');
const { Pool } = require('pg');
const { log, retry, sleep } = require('./common');

const SERVICE = 'tx-sinks';
const TOPIC = process.env.TOPIC || 'pos.transactions';
const brokers = (process.env.KAFKA_BROKERS || 'localhost:9094').split(',');
const HEC_URL = process.env.SPLUNK_HEC_URL || 'http://localhost:8088/services/collector/event';
const HEC_TOKEN = process.env.SPLUNK_HEC_TOKEN || '11111111-2222-3333-4444-555555555555';

const kafka = new Kafka({ clientId: SERVICE, brokers, logLevel: logLevel.WARN });
const pool = new Pool(); // uses PGHOST / PGUSER / PGPASSWORD / PGDATABASE

const UPSERT = `
  INSERT INTO card_transactions
    (id, txn_time, card_masked, card_brand, amount, currency, merchant_id,
     status, response_code, response_text, auth_code, mti, kafka_partition, kafka_offset)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  ON CONFLICT (id) DO UPDATE SET
     status = EXCLUDED.status,
     response_code = EXCLUDED.response_code,
     response_text = EXCLUDED.response_text,
     kafka_partition = EXCLUDED.kafka_partition,
     kafka_offset = EXCLUDED.kafka_offset,
     loaded_at = now()`;

async function toPostgres(e, partition, offset) {
  await pool.query(UPSERT, [
    e.transaction_id, e.txn_time, e.card_masked, e.card_brand, e.amount, e.currency,
    e.merchant_id, e.status, e.response_code, e.response_text, e.auth_code, e.mti,
    partition, Number(offset),
  ]);
}

// Splunk sourcetype per Kafka topic
const SOURCETYPES = {
  'pos.transactions': 'pos:transaction',
  'pos.fraud.alerts': 'pos:fraud',
  'pos.disputes': 'pos:dispute',
};
const SPLUNK_TOPICS = (process.env.SPLUNK_TOPICS || Object.keys(SOURCETYPES).join(',')).split(',');

async function toSplunk(e, partition, offset, topic) {
  const ts = Date.parse(e.txn_time || e.event_time || e.created_at) || Date.now();
  const res = await fetch(HEC_URL, {
    method: 'POST',
    headers: { Authorization: `Splunk ${HEC_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      time: ts / 1000,
      host: 'pos-simulator',
      source: `kafka:${topic}`,
      sourcetype: SOURCETYPES[topic] || 'pos:event',
      event: { ...e, kafka_partition: partition, kafka_offset: Number(offset) },
    }),
  });
  if (!res.ok) throw new Error(`HEC HTTP ${res.status}: ${await res.text()}`);
}

// Run one consumer group. A message is only committed after the sink succeeds;
// on failure we wait and retry the same message (at-least-once delivery).
async function runGroup(groupId, handler, topics = [TOPIC]) {
  const consumer = kafka.consumer({ groupId });
  await retry(() => consumer.connect(), { service: SERVICE, label: `${groupId} connect` });
  await retry(() => consumer.subscribe({ topics, fromBeginning: true }), { service: SERVICE, label: `${groupId} subscribe` });
  log(SERVICE, 'consumer started', { groupId, topics });

  await consumer.run({
    eachMessage: async ({ topic, partition, message, heartbeat }) => {
      const event = JSON.parse(message.value.toString());
      for (let attempt = 1; ; attempt++) {
        try {
          await handler(event, partition, message.offset, topic);
          log(SERVICE, 'delivered', { groupId, topic, id: event.transaction_id, partition, offset: message.offset });
          return;
        } catch (err) {
          if (attempt === 1 || attempt % 10 === 0) {
            log(SERVICE, 'sink not ready, retrying', { groupId, attempt, error: err.message });
          }
          await sleep(3000);
          await heartbeat(); // keep group membership while the sink is down
        }
      }
    },
  });
  return consumer;
}

async function main() {
  const consumers = await Promise.all([
    runGroup('postgres-sink', toPostgres),
    runGroup('splunk-sink', toSplunk, SPLUNK_TOPICS),
  ]);

  const stop = async () => {
    await Promise.all(consumers.map((c) => c.disconnect().catch(() => {})));
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  log(SERVICE, 'fatal', { error: err.message });
  process.exit(1);
});
