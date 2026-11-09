// traffic: sends a realistic mix of card transactions to the POS simulator.
// Uses only the simulator's published test cards (backend/server.js TEST_CARDS).
//   COUNT  = number of transactions (default 100)
//   TPS    = transactions per second (default 2)

const { sleep, log } = require('./common');

const SERVICE = 'traffic';
const POS_API = process.env.POS_API || 'http://host.docker.internal:3001/api';
const COUNT = Number(process.env.COUNT || 100);
// Capped at 20: the producer reads the simulator's latest-50 history every 2s,
// so faster bursts could scroll transactions out before they're published.
// Default 2 TPS stays under the VELOCITY rule for normal traffic; 5+ TPS will trip it on busy cards.
const TPS = Math.min(20, Math.max(0.1, Number(process.env.TPS || 2)));

// [card, weight, merchant pool] — weights give ~88% approvals, ~12% declines
const MIX = [
  { card: '4111111111111111', weight: 35 }, // Visa       -> 00
  { card: '5555555555554444', weight: 25 }, // Mastercard -> 00
  { card: '378282246310005', weight: 15 },  // Amex       -> 00
  { card: '6011111111111117', weight: 13 }, // Discover   -> 00
  { card: '4000000000000002', weight: 8 },  // Visa       -> 51 Insufficient Funds
  { card: '4000000000009987', weight: 4 },  // Visa       -> 41 Lost Card
];
const MERCHANTS = ['MERCHANT01', 'GROCERY-ATL', 'FUEL-CONYERS', 'ECOM-STORE7', 'QSR-DORAVILLE'];
const totalWeight = MIX.reduce((s, m) => s + m.weight, 0);

function pickCard() {
  let r = Math.random() * totalWeight;
  for (const m of MIX) {
    if ((r -= m.weight) < 0) return m.card;
  }
  return MIX[0].card;
}

// Mostly small tickets with an occasional large one (useful for amount-based fraud rules later)
function pickAmount() {
  const big = Math.random() < 0.05;
  const v = big ? 500 + Math.random() * 2000 : 3 + Math.random() * 120;
  return Math.round(v * 100) / 100;
}

async function sendOne(i) {
  const body = {
    card_number: pickCard(),
    exp_date: '12/28',
    cvv: '123',
    amount: pickAmount(),
    merchant_id: MERCHANTS[Math.floor(Math.random() * MERCHANTS.length)],
    description: `lab traffic #${i}`,
  };
  const res = await fetch(`${POS_API}/transactions/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  return { http: res.status, status: out.status, code: out.response_code };
}

async function main() {
  log(SERVICE, 'starting', { POS_API, COUNT, TPS });
  const tally = {};
  for (let i = 1; i <= COUNT; i++) {
    try {
      const r = await sendOne(i);
      const k = r.http === 200 ? `${r.status} ${r.code}` : `HTTP ${r.http}`;
      tally[k] = (tally[k] || 0) + 1;
    } catch (err) {
      log(SERVICE, 'request failed (is the simulator running on :3001?)', { error: err.message });
      process.exit(1);
    }
    if (i % 25 === 0) log(SERVICE, 'progress', { sent: i });
    await sleep(1000 / TPS);
  }
  log(SERVICE, 'done', { sent: COUNT, results: tally });
}

main();
