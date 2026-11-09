// Shared helpers for the POS lab services.

const RESPONSE_TEXT = {
  '00': 'Approved',
  '05': 'Do Not Honor',
  '41': 'Lost Card',
  '43': 'Stolen Card',
  '51': 'Insufficient Funds',
  '54': 'Expired Card',
  '59': 'Suspected Fraud',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(service, msg, extra) {
  const line = { ts: new Date().toISOString(), service, msg, ...(extra || {}) };
  console.log(JSON.stringify(line));
}

// Simulator stores SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC, no zone).
function toIsoUtc(ts) {
  if (!ts) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) return ts.replace(' ', 'T') + 'Z';
  return new Date(ts).toISOString();
}

// Turn a simulator history row into the event published to Kafka.
// Card data is masked (last 4) by the simulator; never add a full PAN here.
function toEvent(row) {
  const iso = row.iso8583_message || {};
  return {
    event_type: 'card.transaction',
    event_version: 1,
    transaction_id: row.id,
    txn_time: toIsoUtc(row.timestamp),
    card_masked: row.card_number_masked,
    card_brand: row.card_brand,
    amount: Number(row.amount),
    currency: row.currency || 'USD',
    merchant_id: row.merchant_id,
    status: row.status,
    response_code: row.response_code,
    response_text: RESPONSE_TEXT[row.response_code] || 'Unknown',
    auth_code: row.auth_code || null,
    mti: iso.mti || null,
  };
}

async function retry(fn, { tries = 30, delayMs = 2000, label = 'operation', service = 'lab' } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log(service, `${label} failed, retrying`, { attempt: i, error: err.message });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = { RESPONSE_TEXT, sleep, log, toIsoUtc, toEvent, retry };
