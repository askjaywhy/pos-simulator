// verify: end-to-end data synchronization check.
//
//   1. Send one known transaction to the POS simulator (source of truth).
//   2. Wait for it to land in Postgres (via Kafka) and compare field by field.
//   3. Wait for it to be searchable in Splunk and compare again.
//
// This is source-to-target validation: the same check you'd run on a real
// payments pipeline or a data migration. Exit code 0 = all checks passed.

const https = require('https');
const { Pool } = require('pg');
const { sleep } = require('./common');

const POS_API = process.env.POS_API || 'http://host.docker.internal:3001/api';
const SPLUNK_API = process.env.SPLUNK_API || 'https://localhost:8089';
const SPLUNK_USER = process.env.SPLUNK_USER || 'admin';
const SPLUNK_PASSWORD = process.env.SPLUNK_PASSWORD || 'PosLab#2026';
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 90000);

const pool = new Pool();
const results = [];

function check(target, field, expected, actual) {
  const pass = String(expected) === String(actual);
  results.push({ target, field, expected: String(expected), actual: String(actual), result: pass ? 'PASS' : 'FAIL' });
}

async function waitFor(label, fn) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const v = await fn().catch(() => null);
    if (v) return { value: v, ms: Date.now() - start };
    await sleep(2000);
  }
  throw new Error(`${label}: not found within ${TIMEOUT_MS / 1000}s`);
}

// Splunk's management port uses a self-signed certificate in this local lab container,
// so certificate checks are relaxed for this one local call only.
function splunkSearch(spl) {
  const body = new URLSearchParams({ search: spl, output_mode: 'json', earliest_time: '-24h' }).toString();
  const url = new URL('/services/search/jobs/export', SPLUNK_API);
  const auth = Buffer.from(`${SPLUNK_USER}:${SPLUNK_PASSWORD}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Splunk HTTP ${res.statusCode}`));
        const rows = data.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.result);
        resolve(rows.map((o) => o.result));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  console.log('verify v3 (Splunk check parses _raw)');
  // 1. Source: create a transaction
  const amount = (10 + Math.random() * 90).toFixed(2);
  const res = await fetch(`${POS_API}/transactions/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_number: '4111111111111111', exp_date: '12/28', cvv: '123', amount: Number(amount), merchant_id: 'VERIFY-01', description: 'pipeline verify' }),
  });
  if (!res.ok) throw new Error(`simulator returned HTTP ${res.status} — is it running on :3001?`);
  const created = await res.json();
  const src = await (await fetch(`${POS_API}/transactions/${created.transaction_id}`)).json();
  console.log(`\nSource transaction ${src.id}  ${src.card_number_masked}  $${src.amount}  ${src.status} ${src.response_code}\n`);

  // 2. Target 1: Postgres (through Kafka)
  const pg = await waitFor('Postgres', async () => (await pool.query('SELECT * FROM card_transactions WHERE id = $1', [src.id])).rows[0]);
  console.log(`Postgres: arrived in ${(pg.ms / 1000).toFixed(1)}s (Kafka partition ${pg.value.kafka_partition}, offset ${pg.value.kafka_offset})`);
  check('postgres', 'card_masked', src.card_number_masked, pg.value.card_masked);
  check('postgres', 'card_brand', src.card_brand, pg.value.card_brand);
  check('postgres', 'amount', Number(src.amount).toFixed(2), Number(pg.value.amount).toFixed(2));
  check('postgres', 'status', src.status, pg.value.status);
  check('postgres', 'response_code', src.response_code, pg.value.response_code);
  check('postgres', 'auth_code', src.auth_code, pg.value.auth_code);
  check('postgres', 'merchant_id', src.merchant_id, pg.value.merchant_id);
  check('postgres', 'mti', src.iso8583_message.mti, pg.value.mti);

  // 3. Target 2: Splunk
  const sp = await waitFor('Splunk', async () => {
    // Fetch the raw event and parse its JSON here, so the check doesn't depend on
    // Splunk's search-time field extraction (the REST API omits those fields).
    const rows = await splunkSearch(
      `search sourcetype="pos:transaction" "${src.id}" | head 1 | fields _raw`
    );
    if (!rows[0] || !rows[0]._raw) return null;
    return JSON.parse(rows[0]._raw);
  });
  console.log(`Splunk:   searchable in ${(sp.ms / 1000).toFixed(1)}s\n`);
  check('splunk', 'card_masked', src.card_number_masked, sp.value.card_masked);
  check('splunk', 'amount', Number(src.amount).toFixed(2), Number(sp.value.amount).toFixed(2));
  check('splunk', 'status', src.status, sp.value.status);
  check('splunk', 'response_code', src.response_code, sp.value.response_code);

  console.table(results);
  const failed = results.filter((r) => r.result === 'FAIL').length;
  console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} of ${results.length} CHECKS FAILED`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`\nVERIFY ERROR: ${err.message}`);
  if (results.length) console.table(results);
  await pool.end().catch(() => {});
  process.exit(2);
});
