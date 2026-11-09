// fraud-scenarios: end-to-end tests for the fraud & chargeback module.
//
// Drives real transactions through the POS simulator, waits for them to flow
// simulator -> Kafka -> fraud engine / Postgres, then checks the risk API.
// Exit code 0 = all checks passed.
//
//   docker compose run --rm --build fraud-scenarios

const POS_API = process.env.POS_API || 'http://host.docker.internal:3001/api';
const RISK_API = process.env.RISK_API || 'http://risk-service:3002/api';
const TIMEOUT_MS = Number(process.env.SCENARIO_TIMEOUT_MS || 60000);
const RUN = Date.now().toString(36).slice(-5).toUpperCase(); // unique merchant suffix per run

// Simulator test cards (backend/server.js TEST_CARDS)
const CARD = { VISA: '4111111111111111', MC: '5555555555554444', AMEX: '378282246310005', DISC: '6011111111111117', LOST: '4000000000009987' };

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(scenario, name, expected, actual) {
  const pass = String(expected) === String(actual);
  results.push({ scenario, check: name, expected: String(expected), actual: String(actual), result: pass ? 'PASS' : 'FAIL' });
  return pass;
}

async function http(base, path, method = 'GET', body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const risk = (p, m, b) => http(RISK_API, p, m, b);

async function pay(card, amount, merchant) {
  const r = await http(POS_API, '/transactions/process', 'POST', { card_number: card, exp_date: '12/28', cvv: '123', amount, merchant_id: merchant, description: `scenario ${RUN}` });
  if (r.status !== 200) throw new Error(`simulator HTTP ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
}

async function waitFor(label, fn) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(1500);
  }
  throw new Error(`timed out after ${TIMEOUT_MS / 1000}s waiting for: ${label}`);
}
const alertsFor = async (q) => (await risk('/fraud/alerts?' + new URLSearchParams(q))).data.alerts || [];

// Wait until postgres-sink has loaded a transaction. Probes POST /disputes with an invalid
// reason code: 404 = not loaded yet, 422 = loaded (rejected for another reason, nothing created).
async function waitLoaded(transactionId) {
  await waitFor(`transaction ${transactionId} in Postgres`, async () =>
    (await risk('/disputes', 'POST', { transaction_id: transactionId, reason_code: 'PROBE' })).status === 422);
}

// File a dispute, retrying 404 until the pipeline has loaded the transaction into Postgres.
async function fileWhenLoaded(body) {
  return waitFor(`transaction ${body.transaction_id} in Postgres`, async () => {
    const r = await risk('/disputes', 'POST', body);
    return r.status === 404 ? null : r;
  });
}

async function main() {
  console.log(`fraud-scenarios run ${RUN}\n`);
  const health = await risk('/health');
  if (health.status !== 200) throw new Error(`risk-service not healthy (HTTP ${health.status}) — is it running?`);
  const rules = Object.fromEntries((await risk('/fraud/rules')).data.rules.map((r) => [r.rule_id, r]));

  // S1 Velocity: burst on one card at one merchant -> exactly one VELOCITY alert (dedup)
  {
    const s = 'S1 velocity';
    const merchant = `VEL-${RUN}`;
    const n = Number(rules.VELOCITY.params.max_txns) + 2;
    for (let i = 0; i < n; i++) await pay(CARD.DISC, 4.99, merchant);
    const alerts = await waitFor('velocity alert', async () => {
      const a = (await alertsFor({ rule_id: 'VELOCITY', card: '1117' })).filter((x) => x.merchant_id === merchant);
      return a.length ? a : null;
    });
    await sleep(3000); // let the remaining burst transactions score, then confirm dedup held
    const after = (await alertsFor({ rule_id: 'VELOCITY', card: '1117' })).filter((x) => x.merchant_id === merchant);
    check(s, `${n} txns in burst -> VELOCITY alert raised`, true, alerts.length > 0);
    check(s, 'dedup: exactly one alert for the burst', 1, after.length);
    check(s, 'severity', rules.VELOCITY.severity, after[0] && after[0].severity);
  }

  // S2 High amount on an approved Amex
  let s2Alert;
  {
    const s = 'S2 high amount';
    const amount = Number(rules.HIGH_AMOUNT.params.min_amount) + 250;
    const tx = await pay(CARD.AMEX, amount, `ECOM-${RUN}`);
    check(s, 'simulator approved', 'APPROVED 00', `${tx.status} ${tx.response_code}`);
    s2Alert = await waitFor('high amount alert', async () =>
      (await alertsFor({ rule_id: 'HIGH_AMOUNT' })).find((a) => a.transaction_id === tx.transaction_id));
    check(s, 'HIGH_AMOUNT alert for this transaction', tx.transaction_id, s2Alert.transaction_id);
    check(s, 'alert amount', amount.toFixed(2), Number(s2Alert.amount).toFixed(2));
  }

  // S3 Lost card -> alert (or existing open alert) + automatic block
  let lostTx;
  {
    const s = 'S3 lost card';
    lostTx = await pay(CARD.LOST, 42.0, `POS-${RUN}`);
    check(s, 'simulator declined 41', 'DECLINED 41', `${lostTx.status} ${lostTx.response_code}`);
    const open = await waitFor('LOST_STOLEN alert', async () => {
      const a = await alertsFor({ rule_id: 'LOST_STOLEN', card: '9987', status: 'OPEN' });
      return a.length ? a : null;
    });
    check(s, 'open LOST_STOLEN alert exists for •••• 9987', true, open.length > 0);
    const blocks = (await risk('/cards/blocks?active=true')).data.blocks;
    check(s, 'card •••• 9987 automatically blocked', true, blocks.some((b) => b.card_masked === '•••• 9987'));
  }

  // S4 Approved on a blocked card -> critical alert (simulator does not honor blocks)
  {
    const s = 'S4 blocked card';
    let block = await risk('/cards/blocks', 'POST', { card: '4444', reason: `scenario ${RUN}`, analyst: 'scenarios' });
    let blockId = block.data.block_id;
    if (block.status === 409) blockId = null; // already blocked by someone else; leave it as found
    check(s, 'block created (201) or already active (409)', true, [201, 409].includes(block.status));
    const tx = await pay(CARD.MC, 18.25, `POS-${RUN}`);
    const crit = await waitFor('BLOCKED_CARD_ACTIVITY alert', async () =>
      (await alertsFor({ rule_id: 'BLOCKED_CARD_ACTIVITY', card: '4444' })).find((a) => a.transaction_id === tx.transaction_id));
    check(s, 'critical alert for approved txn on blocked card', 'critical', crit.severity);
    if (blockId) {
      const rel = await risk(`/cards/blocks/${blockId}/release`, 'POST', { analyst: 'scenarios' });
      check(s, 'cleanup: block released', 200, rel.status);
    }
  }

  // S5 Confirm fraud on S2 -> automatic fraud chargeback (AMEX F29)
  let s5Dispute;
  {
    const s = 'S5 confirm fraud';
    await waitLoaded(s2Alert.transaction_id);
    const r = await risk(`/fraud/alerts/${s2Alert.alert_id}/review`, 'POST', { decision: 'CONFIRMED_FRAUD', analyst: 'scenarios', note: 'cardholder denies' });
    check(s, 'review accepted', 200, r.status);
    s5Dispute = r.data.dispute;
    check(s, 'fraud chargeback filed', true, !!s5Dispute);
    check(s, 'reason code = AMEX fraud', 'AMEX F29', s5Dispute && `${s5Dispute.network} ${s5Dispute.reason_code}`);
    check(s, 'state', 'CHARGEBACK_FILED', s5Dispute && s5Dispute.state);
    check(s, 'alert linked to dispute', s5Dispute && s5Dispute.dispute_id, r.data.alert && r.data.alert.dispute_id);
  }

  // S6 Full lifecycle: representment -> pre-arb -> arbitration, merchant wins
  {
    const s = 'S6 arbitration';
    const tx = await pay(CARD.VISA, 120.0, `SHOP-${RUN}`);
    const filed = await fileWhenLoaded({ transaction_id: tx.transaction_id, reason_code: '13.1', amount: 60, note: 'item never arrived' });
    check(s, 'partial chargeback filed (201)', 201, filed.status);
    const id = filed.data.dispute_id;
    const steps = [['represent', 'Proof of delivery: carrier tracking, signed'], ['pre_arbitration', 'Cardholder: signature is not mine'], ['escalate_arbitration', null], ['ruling_merchant', null]];
    let last;
    for (const [action, note] of steps) {
      last = await risk(`/disputes/${id}/actions`, 'POST', { action, note });
      check(s, `${action} -> 200`, 200, last.status);
    }
    const d = (await risk(`/disputes/${id}`)).data;
    check(s, 'final state', 'CLOSED_MERCHANT_WON', d.state);
    check(s, 'liability', 'cardholder', d.liability);
    check(s, 'provisional credit reversed', false, d.provisional_credit);
    check(s, 'audit trail events', 5, d.events.length);
  }

  // S7 Merchant accepts
  {
    const s = 'S7 merchant accepts';
    const tx = await pay(CARD.VISA, 35.5, `SHOP-${RUN}`);
    const filed = await fileWhenLoaded({ transaction_id: tx.transaction_id, reason_code: '13.7', note: 'cancelled subscription' });
    const r = await risk(`/disputes/${filed.data.dispute_id}/actions`, 'POST', { action: 'merchant_accept' });
    check(s, 'final state', 'CLOSED_CARDHOLDER_WON', r.data.state);
    check(s, 'liability', 'merchant', r.data.liability);
    check(s, 'cardholder keeps credit', true, r.data.provisional_credit);
  }

  // S8 Negative tests: the API must reject invalid requests
  {
    const s = 'S8 negative';
    const visaTx = await pay(CARD.VISA, 50.0, `NEG-${RUN}`);
    await waitLoaded(visaTx.transaction_id);
    await waitLoaded(lostTx.transaction_id);
    const cases = [
      ['dispute a declined txn', 422, () => risk('/disputes', 'POST', { transaction_id: lostTx.transaction_id, reason_code: '13.1' })],
      ['amount above transaction', 422, () => risk('/disputes', 'POST', { transaction_id: visaTx.transaction_id, reason_code: '13.1', amount: 50.01 })],
      ['Mastercard code on a Visa txn', 422, () => risk('/disputes', 'POST', { transaction_id: visaTx.transaction_id, reason_code: '4853' })],
      ['unknown transaction', 404, () => risk('/disputes', 'POST', { transaction_id: 'does-not-exist', reason_code: '13.1' })],
      ['second open dispute on same txn', 409, () => risk('/disputes', 'POST', { transaction_id: s5Dispute.transaction_id, reason_code: 'C08' })],
      ['arbitration ruling before representment', 409, () => risk(`/disputes/${s5Dispute.dispute_id}/actions`, 'POST', { action: 'ruling_merchant' })],
      ['represent without evidence', 422, () => risk(`/disputes/${s5Dispute.dispute_id}/actions`, 'POST', { action: 'represent' })],
      ['review an already-reviewed alert', 409, () => risk(`/fraud/alerts/${s2Alert.alert_id}/review`, 'POST', { decision: 'FALSE_POSITIVE' })],
      ['invalid rule threshold', 422, () => risk('/fraud/rules/VELOCITY', 'PUT', { params: { max_txns: 0 } })],
      ['block without reason', 422, () => risk('/cards/blocks', 'POST', { card: '1111' })],
    ];
    for (const [name, expected, fn] of cases) check(s, name, expected, (await fn()).status);
  }

  console.table(results);
  const failed = results.filter((r) => r.result === 'FAIL').length;
  console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} of ${results.length} CHECKS FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nSCENARIO ERROR: ${err.message}`);
  if (results.length) console.table(results);
  process.exit(2);
});
