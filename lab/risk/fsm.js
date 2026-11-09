// Dispute / chargeback lifecycle (simplified card-network flow).
//
//   CHARGEBACK_FILED ──merchant_accept──────────────► CLOSED_CARDHOLDER_WON
//        │  └─withdraw (issuer)─────────────────────► CLOSED_WITHDRAWN
//        └─represent (merchant, evidence)──► REPRESENTED
//                                              │ └─issuer_accept──────► CLOSED_MERCHANT_WON
//                                              └─pre_arbitration (issuer)──► PRE_ARBITRATION
//                                                    │ └─merchant_accept──► CLOSED_CARDHOLDER_WON
//                                                    └─escalate_arbitration (merchant)──► ARBITRATION
//                                                          ├─ruling_cardholder (network)──► CLOSED_CARDHOLDER_WON
//                                                          └─ruling_merchant  (network)──► CLOSED_MERCHANT_WON
//
// Money: the cardholder gets provisional credit when the chargeback is filed.
//   CLOSED_CARDHOLDER_WON -> credit stays, merchant is liable
//   CLOSED_MERCHANT_WON / CLOSED_WITHDRAWN -> provisional credit reversed, cardholder is liable

const STATES = {
  CHARGEBACK_FILED: 'CHARGEBACK_FILED',
  REPRESENTED: 'REPRESENTED',
  PRE_ARBITRATION: 'PRE_ARBITRATION',
  ARBITRATION: 'ARBITRATION',
  CLOSED_CARDHOLDER_WON: 'CLOSED_CARDHOLDER_WON',
  CLOSED_MERCHANT_WON: 'CLOSED_MERCHANT_WON',
  CLOSED_WITHDRAWN: 'CLOSED_WITHDRAWN',
};

const INITIAL = { state: STATES.CHARGEBACK_FILED, actor: 'issuer', respondDays: 30 };

const TRANSITIONS = {
  CHARGEBACK_FILED: {
    merchant_accept: { to: STATES.CLOSED_CARDHOLDER_WON, actor: 'merchant' },
    represent: { to: STATES.REPRESENTED, actor: 'merchant', requiresNote: true, respondDays: 30 },
    withdraw: { to: STATES.CLOSED_WITHDRAWN, actor: 'issuer' },
  },
  REPRESENTED: {
    issuer_accept: { to: STATES.CLOSED_MERCHANT_WON, actor: 'issuer' },
    pre_arbitration: { to: STATES.PRE_ARBITRATION, actor: 'issuer', requiresNote: true, respondDays: 30 },
  },
  PRE_ARBITRATION: {
    merchant_accept: { to: STATES.CLOSED_CARDHOLDER_WON, actor: 'merchant' },
    escalate_arbitration: { to: STATES.ARBITRATION, actor: 'merchant', respondDays: 10 },
  },
  ARBITRATION: {
    ruling_cardholder: { to: STATES.CLOSED_CARDHOLDER_WON, actor: 'network' },
    ruling_merchant: { to: STATES.CLOSED_MERCHANT_WON, actor: 'network' },
  },
};

const OUTCOME = {
  CLOSED_CARDHOLDER_WON: { liability: 'merchant', provisional_credit: true },
  CLOSED_MERCHANT_WON: { liability: 'cardholder', provisional_credit: false },
  CLOSED_WITHDRAWN: { liability: 'cardholder', provisional_credit: false },
};

const isClosed = (state) => state.startsWith('CLOSED_');
const allowedActions = (state) => Object.keys(TRANSITIONS[state] || {});

// Returns { ok: true, ... } or { ok: false, status, error, allowed }
function applyAction(state, action, note) {
  const t = (TRANSITIONS[state] || {})[action];
  if (!t) {
    return {
      ok: false,
      status: 409,
      error: isClosed(state)
        ? `dispute is closed (${state}); no further actions allowed`
        : `action '${action}' is not allowed in state ${state}`,
      allowed: allowedActions(state),
    };
  }
  if (t.requiresNote && !(note && String(note).trim())) {
    return { ok: false, status: 422, error: `action '${action}' requires a note (evidence / rationale)`, allowed: allowedActions(state) };
  }
  const closed = isClosed(t.to);
  return {
    ok: true,
    from: state,
    to: t.to,
    actor: t.actor,
    closed,
    respondDays: t.respondDays || null,
    ...(closed ? OUTCOME[t.to] : {}),
  };
}

module.exports = { STATES, INITIAL, TRANSITIONS, applyAction, allowedActions, isClosed };
