// risk-service: fraud engine (Kafka consumer) + risk API + back-office console on :3002.

const path = require('path');
const express = require('express');
const { Kafka, logLevel } = require('kafkajs');
const { applySchema } = require('./db');
const { startEngine } = require('./engine');
const { buildApi } = require('./api');

const PORT = Number(process.env.PORT || 3002);
const brokers = (process.env.KAFKA_BROKERS || 'localhost:9094').split(',');
const TOPIC = process.env.TOPIC || 'pos.transactions';

const log = (msg, extra) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'risk-service', msg, ...(extra || {}) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(label, fn, tries = 30) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= tries) throw err;
      log(`${label} failed, retrying`, { attempt: i, error: err.message });
      await sleep(2000);
    }
  }
}

async function main() {
  await retry('apply schema', applySchema);
  log('schema ready');

  const kafka = new Kafka({ clientId: 'risk-service', brokers, logLevel: logLevel.WARN });
  const producer = kafka.producer({ allowAutoTopicCreation: true });
  await retry('kafka producer connect', () => producer.connect());

  const publish = async (topic, key, value) => {
    // Normalize pg values (Dates, NUMERIC strings) into plain JSON
    const body = JSON.parse(JSON.stringify(value));
    if (body.amount !== undefined && body.amount !== null) body.amount = Number(body.amount);
    if (!body.event_time) body.event_time = new Date().toISOString();
    await producer.send({ topic, messages: [{ key: String(key || ''), value: JSON.stringify(body) }] });
  };

  const app = express();
  app.use(express.json());
  app.use('/api', buildApi(publish));
  app.use(express.static(path.join(__dirname, 'public')));
  app.listen(PORT, () => log('risk API and console listening', { url: `http://localhost:${PORT}` }));

  await retry('fraud engine start', () => startEngine(kafka, publish, TOPIC));
}

main().catch((err) => {
  log('fatal', { error: err.message });
  process.exit(1);
});
