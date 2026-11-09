// tx-producer: polls the POS simulator and publishes each new transaction to Kafka.
//
// The simulator is not modified. It keeps transactions in memory, so this service
// watches GET /api/transactions/history (latest 50) and publishes ids it hasn't seen.
// Message key = masked card, so all events for one card land on one partition in order
// (that ordering matters later for velocity fraud rules).

const { Kafka, logLevel } = require('kafkajs');
const { sleep, log, toEvent, retry } = require('./common');

const SERVICE = 'tx-producer';
const POS_API = process.env.POS_API || 'http://host.docker.internal:3001/api';
const TOPIC = process.env.TOPIC || 'pos.transactions';
const POLL_MS = Number(process.env.POLL_MS || 2000);
const brokers = (process.env.KAFKA_BROKERS || 'localhost:9094').split(',');

const kafka = new Kafka({ clientId: SERVICE, brokers, logLevel: logLevel.WARN });
const producer = kafka.producer({ allowAutoTopicCreation: true });

const seen = new Set();
let simWasUp = null;

async function fetchHistory() {
  const res = await fetch(`${POS_API}/transactions/history`);
  if (!res.ok) throw new Error(`history HTTP ${res.status}`);
  const body = await res.json();
  return body.transactions || [];
}

async function pollOnce() {
  let rows;
  try {
    rows = await fetchHistory();
    if (simWasUp !== true) log(SERVICE, 'POS simulator reachable', { POS_API });
    simWasUp = true;
  } catch (err) {
    if (simWasUp !== false) log(SERVICE, 'POS simulator not reachable (is it running?)', { POS_API, error: err.message });
    simWasUp = false;
    return;
  }

  // History is newest-first; publish oldest-first so Kafka order matches simulator order.
  const fresh = rows.filter((r) => !seen.has(r.id)).reverse();
  if (fresh.length === 0) return;

  const messages = fresh.map((row) => {
    const event = toEvent(row);
    return {
      key: event.card_masked,
      value: JSON.stringify(event),
      headers: { event_type: event.event_type, source: 'pos-simulator' },
    };
  });

  await producer.send({ topic: TOPIC, messages });
  fresh.forEach((r) => seen.add(r.id));
  log(SERVICE, 'published', { count: messages.length, topic: TOPIC });
}

async function main() {
  await retry(() => producer.connect(), { service: SERVICE, label: 'kafka connect' });
  log(SERVICE, 'connected to Kafka', { brokers, topic: TOPIC, pollMs: POLL_MS });

  let running = true;
  const stop = async () => {
    running = false;
    await producer.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (running) {
    try {
      await pollOnce();
    } catch (err) {
      log(SERVICE, 'poll error', { error: err.message });
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  log(SERVICE, 'fatal', { error: err.message });
  process.exit(1);
});
