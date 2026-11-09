// Unit tests for the pure rule engine and dispute state machine.
// Run:  node --test tests/unit.test.js   (from lab/risk, no dependencies needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, validateRuleUpdate } = require('../rules');
const fsm = require('../fsm');

const RULES = {
  VELOCITY: { severity: 'high', params: { max_txns: 10, window_seconds: 30, dedup_seconds: 300 } },
  HIGH_AMOUNT: { severity: 'medium', params: { min_amount: 2000 } },
  LOST_STOLEN: { severity: 'high', params: { response_codes: ['41', '43'], auto_block: true, dedup_seconds: 3600 } },
  BLOCKED_CARD_ACTIVITY: { severity: 'critical', params: {} },
};
const tx = (o) => ({ transaction_id: 't', card_masked: '•••• 1111', merchant_id: 'M1', amount: 25, status: 'APPROVED', response_code: '00', ...o });
const ids = (list) => list.map((a) => a.rule_id).sort();

test('clean transaction raises no alerts', () => {
  assert.deepEqual(evaluate(tx(), RULES, { velocityCount: 1, cardBlocked: false }), []);
});

test('velocity fires at the limit, not below it', () => {
  assert.deepEqual(ids(evaluate(tx(), RULES, { velocityCount: 9, cardBlocked: false })), []);
  assert.deepEqual(ids(evaluate(tx(), RULES, { velocityCount: 10, cardBlocked: false })), ['VELOCITY']);
});

test('high amount boundary is inclusive', () => {
  assert.deepEqual(ids(evaluate(tx({ amount: 1999.99 }), RULES, { velocityCount: 1 })), []);
  assert.deepEqual(ids(evaluate(tx({ amount: 2000 }), RULES, { velocityCount: 1 })), ['HIGH_AMOUNT']);
});

test('lost card decline alerts and requests a block', () => {
  const out = evaluate(tx({ status: 'DECLINED', response_code: '41' }), RULES, { velocityCount: 1 });
  assert.deepEqual(ids(out), ['LOST_STOLEN']);
  assert.equal(out[0].block, true);
});

test('insufficient funds decline is not a fraud signal', () => {
  assert.deepEqual(evaluate(tx({ status: 'DECLINED', response_code: '51' }), RULES, { velocityCount: 1 }), []);
});

test('approved on a blocked card is critical; declined on a blocked card is not', () => {
  assert.deepEqual(ids(evaluate(tx(), RULES, { velocityCount: 1, cardBlocked: true })), ['BLOCKED_CARD_ACTIVITY']);
  assert.deepEqual(ids(evaluate(tx({ status: 'DECLINED', response_code: '05' }), RULES, { velocityCount: 1, cardBlocked: true })), []);
});

test('disabled rules (absent from the map) never fire', () => {
  const { HIGH_AMOUNT, ...rest } = RULES;
  assert.deepEqual(evaluate(tx({ amount: 5000 }), rest, { velocityCount: 1 }), []);
});

test('rule update validation', () => {
  assert.equal(validateRuleUpdate('VELOCITY', { params: { max_txns: 5 } }), null);
  assert.match(validateRuleUpdate('VELOCITY', { params: { max_txns: 0 } }), /positive integer/);
  assert.match(validateRuleUpdate('HIGH_AMOUNT', { params: { min_amount: -1 } }), /greater than 0/);
  assert.match(validateRuleUpdate('LOST_STOLEN', { params: { response_codes: ['4'] } }), /2-digit/);
  assert.match(validateRuleUpdate('VELOCITY', { severity: 'urgent' }), /severity/);
});

test('full arbitration path, merchant wins', () => {
  let s = fsm.INITIAL.state;
  for (const [action, note] of [['represent', 'POD'], ['pre_arbitration', 'still disputes'], ['escalate_arbitration'], ['ruling_merchant']]) {
    const r = fsm.applyAction(s, action, note);
    assert.equal(r.ok, true, `${action} from ${s}`);
    s = r.to;
    if (action === 'ruling_merchant') {
      assert.equal(r.closed, true);
      assert.equal(r.liability, 'cardholder');
      assert.equal(r.provisional_credit, false);
    }
  }
  assert.equal(s, 'CLOSED_MERCHANT_WON');
});

test('merchant accepts: cardholder keeps credit, merchant liable', () => {
  const r = fsm.applyAction('CHARGEBACK_FILED', 'merchant_accept');
  assert.deepEqual([r.to, r.liability, r.provisional_credit], ['CLOSED_CARDHOLDER_WON', 'merchant', true]);
});

test('invalid transitions are rejected with 409 and the allowed actions', () => {
  const r = fsm.applyAction('CHARGEBACK_FILED', 'ruling_merchant');
  assert.equal(r.status, 409);
  assert.deepEqual(r.allowed.sort(), ['merchant_accept', 'represent', 'withdraw']);
  assert.equal(fsm.applyAction('CLOSED_MERCHANT_WON', 'represent', 'x').status, 409);
});

test('representment without evidence is rejected with 422', () => {
  assert.equal(fsm.applyAction('CHARGEBACK_FILED', 'represent', '  ').status, 422);
});
