// Fraud rule evaluation (pure function, no I/O).
//
// Input:  event  - a pos.transactions event
//         rules  - enabled rows from fraud_rules, keyed by rule_id
//         ctx    - { velocityCount, cardBlocked }  (looked up by the engine)
// Output: list of candidate alerts; the engine applies dedup and writes them.

function evaluate(event, rules, ctx) {
  const out = [];
  const amt = Number(event.amount);

  const v = rules.VELOCITY;
  if (v && ctx.velocityCount >= Number(v.params.max_txns)) {
    out.push({
      rule_id: 'VELOCITY',
      severity: v.severity,
      detail: `${ctx.velocityCount} transactions on ${event.card_masked} at ${event.merchant_id} within ${v.params.window_seconds}s (limit ${v.params.max_txns})`,
      dedupSeconds: Number(v.params.dedup_seconds || 0),
      dedupByMerchant: true,
    });
  }

  const h = rules.HIGH_AMOUNT;
  if (h && amt >= Number(h.params.min_amount)) {
    out.push({
      rule_id: 'HIGH_AMOUNT',
      severity: h.severity,
      detail: `Amount $${amt.toFixed(2)} is at or above $${Number(h.params.min_amount).toFixed(2)}`,
      dedupSeconds: 0,
    });
  }

  const l = rules.LOST_STOLEN;
  if (l && (l.params.response_codes || []).includes(event.response_code)) {
    out.push({
      rule_id: 'LOST_STOLEN',
      severity: l.severity,
      detail: `Authorization attempt on ${event.card_masked} returned ${event.response_code} ${event.response_text || ''}`.trim(),
      dedupSeconds: Number(l.params.dedup_seconds || 0),
      block: l.params.auto_block !== false,
    });
  }

  const b = rules.BLOCKED_CARD_ACTIVITY;
  if (b && ctx.cardBlocked && event.status === 'APPROVED') {
    out.push({
      rule_id: 'BLOCKED_CARD_ACTIVITY',
      severity: b.severity,
      detail: `APPROVED $${amt.toFixed(2)} on ${event.card_masked} while an active fraud block exists; authorization did not honor the block`,
      dedupSeconds: 0,
    });
  }

  return out;
}

// Validate a rule update from the API. Returns an error string or null.
function validateRuleUpdate(ruleId, body) {
  const SEV = ['low', 'medium', 'high', 'critical'];
  if (body.severity !== undefined && !SEV.includes(body.severity)) return `severity must be one of ${SEV.join(', ')}`;
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return 'enabled must be true or false';
  if (body.params !== undefined) {
    const p = body.params;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return 'params must be an object';
    const positiveInt = (k) => p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] > 0) ? `${k} must be a positive integer` : null;
    if (ruleId === 'VELOCITY') return positiveInt('max_txns') || positiveInt('window_seconds') || (p.dedup_seconds !== undefined && !(Number.isInteger(p.dedup_seconds) && p.dedup_seconds >= 0) ? 'dedup_seconds must be 0 or more' : null);
    if (ruleId === 'HIGH_AMOUNT' && p.min_amount !== undefined && !(typeof p.min_amount === 'number' && p.min_amount > 0)) return 'min_amount must be a number greater than 0';
    if (ruleId === 'LOST_STOLEN') {
      if (p.response_codes !== undefined && !(Array.isArray(p.response_codes) && p.response_codes.every((c) => /^\d{2}$/.test(c)))) return 'response_codes must be a list of 2-digit codes';
      if (p.auto_block !== undefined && typeof p.auto_block !== 'boolean') return 'auto_block must be true or false';
    }
  }
  return null;
}

module.exports = { evaluate, validateRuleUpdate };
