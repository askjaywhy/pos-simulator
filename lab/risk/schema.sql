-- POS Lab risk schema: fraud rules, alerts, card blocks, disputes / chargebacks.
-- Applied by risk-service on every start (idempotent), so it works on an existing database.

-- ---------- Fraud ----------
CREATE TABLE IF NOT EXISTS fraud_rules (
    rule_id     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
    enabled     BOOLEAN NOT NULL DEFAULT true,
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fraud_rules (rule_id, name, description, severity, params) VALUES
 ('VELOCITY', 'Velocity', 'Too many transactions on one card at one merchant in a short window', 'high',
  '{"max_txns": 10, "window_seconds": 30, "dedup_seconds": 300}'),
 ('HIGH_AMOUNT', 'High amount', 'Single transaction at or above the amount threshold', 'medium',
  '{"min_amount": 2000}'),
 ('LOST_STOLEN', 'Lost/stolen card attempt', 'Authorization returned DE39 41 (lost) or 43 (stolen); card is blocked automatically', 'high',
  '{"response_codes": ["41","43"], "auto_block": true, "dedup_seconds": 3600}'),
 ('BLOCKED_CARD_ACTIVITY', 'Approved on blocked card', 'An APPROVED authorization on a card with an active fraud block', 'critical',
  '{}')
ON CONFLICT (rule_id) DO NOTHING;

-- Every transaction the engine has scored (velocity window + idempotency)
CREATE TABLE IF NOT EXISTS fraud_scored_txns (
    transaction_id TEXT PRIMARY KEY,
    card_masked    TEXT NOT NULL,
    merchant_id    TEXT,
    txn_time       TIMESTAMPTZ NOT NULL,
    scored_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_scored_card_merchant_time ON fraud_scored_txns (card_masked, merchant_id, txn_time);

CREATE TABLE IF NOT EXISTS fraud_alerts (
    alert_id        BIGSERIAL PRIMARY KEY,
    rule_id         TEXT NOT NULL REFERENCES fraud_rules(rule_id),
    severity        TEXT NOT NULL,
    transaction_id  TEXT NOT NULL,
    card_masked     TEXT NOT NULL,
    merchant_id     TEXT,
    amount          NUMERIC(12,2),
    txn_status      TEXT,
    response_code   CHAR(2),
    detail          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED_FRAUD','FALSE_POSITIVE')),
    reviewed_by     TEXT,
    reviewed_at     TIMESTAMPTZ,
    review_note     TEXT,
    dispute_id      BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (rule_id, transaction_id)          -- redelivered messages can't double-alert
);
CREATE INDEX IF NOT EXISTS ix_alerts_status ON fraud_alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_alerts_card   ON fraud_alerts (card_masked, rule_id, created_at DESC);

CREATE TABLE IF NOT EXISTS card_blocks (
    block_id     BIGSERIAL PRIMARY KEY,
    card_masked  TEXT NOT NULL,
    reason       TEXT NOT NULL,
    source       TEXT NOT NULL,              -- 'rule:LOST_STOLEN' or 'analyst'
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at  TIMESTAMPTZ,
    released_by  TEXT
);
-- At most one active block per card
CREATE UNIQUE INDEX IF NOT EXISTS ux_card_blocks_active ON card_blocks (card_masked) WHERE active;

-- ---------- Disputes / chargebacks ----------
CREATE TABLE IF NOT EXISTS chargeback_reason_codes (
    network     TEXT NOT NULL,               -- VISA / MASTERCARD / AMEX / DISCOVER (matches card_brand)
    code        TEXT NOT NULL,
    description TEXT NOT NULL,
    category    TEXT NOT NULL CHECK (category IN ('fraud','consumer','processing')),
    PRIMARY KEY (network, code)
);

INSERT INTO chargeback_reason_codes (network, code, description, category) VALUES
 ('VISA','10.4','Other Fraud – Card-Absent Environment','fraud'),
 ('VISA','12.6.1','Duplicate Processing','processing'),
 ('VISA','13.1','Merchandise/Services Not Received','consumer'),
 ('VISA','13.3','Not as Described or Defective Merchandise/Services','consumer'),
 ('VISA','13.7','Cancelled Merchandise/Services','consumer'),
 ('MASTERCARD','4837','No Cardholder Authorization','fraud'),
 ('MASTERCARD','4834','Point-of-Interaction Error (e.g. duplicate)','processing'),
 ('MASTERCARD','4853','Cardholder Dispute','consumer'),
 ('AMEX','F29','Card Not Present (fraud)','fraud'),
 ('AMEX','P08','Duplicate Charge','processing'),
 ('AMEX','C08','Goods/Services Not Received or Only Partially Received','consumer'),
 ('DISCOVER','UA02','Fraud – Card Not Present Transaction','fraud'),
 ('DISCOVER','DP','Duplicate Processing','processing'),
 ('DISCOVER','RG','Non-Receipt of Goods, Services or Cash','consumer')
ON CONFLICT (network, code) DO NOTHING;

CREATE TABLE IF NOT EXISTS disputes (
    dispute_id          BIGSERIAL PRIMARY KEY,
    transaction_id      TEXT NOT NULL,
    card_masked         TEXT NOT NULL,
    card_brand          TEXT NOT NULL,
    merchant_id         TEXT,
    txn_amount          NUMERIC(12,2) NOT NULL,
    dispute_amount      NUMERIC(12,2) NOT NULL CHECK (dispute_amount > 0),
    network             TEXT NOT NULL,
    reason_code         TEXT NOT NULL,
    state               TEXT NOT NULL,
    provisional_credit  BOOLEAN NOT NULL DEFAULT true,   -- cardholder credited while dispute is open
    liability           TEXT,                            -- final: 'merchant' or 'cardholder'
    source              TEXT NOT NULL DEFAULT 'cardholder', -- 'cardholder' or 'fraud_alert:<id>'
    respond_by          DATE,                            -- next deadline for the party that must act
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at           TIMESTAMPTZ,
    FOREIGN KEY (network, reason_code) REFERENCES chargeback_reason_codes (network, code)
);
-- At most one open dispute per transaction
CREATE UNIQUE INDEX IF NOT EXISTS ux_disputes_open_txn ON disputes (transaction_id) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS dispute_events (
    event_id    BIGSERIAL PRIMARY KEY,
    dispute_id  BIGINT NOT NULL REFERENCES disputes(dispute_id),
    action      TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT NOT NULL,
    actor       TEXT NOT NULL,              -- issuer / merchant / network / system
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_dispute_events_dispute ON dispute_events (dispute_id, event_id);
