-- POS Lab: downstream store for transactions streamed from Kafka.
-- Later (AWS week) this database plays the "on-prem source" for migration testing.

CREATE TABLE IF NOT EXISTS card_transactions (
    id              TEXT PRIMARY KEY,          -- simulator transaction id (UUID)
    txn_time        TIMESTAMPTZ NOT NULL,
    card_masked     TEXT NOT NULL,             -- last 4 only, never a full PAN
    card_brand      TEXT,
    amount          NUMERIC(12,2) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    merchant_id     TEXT,
    status          TEXT NOT NULL,             -- APPROVED / DECLINED
    response_code   CHAR(2) NOT NULL,          -- ISO 8583 DE39
    response_text   TEXT,
    auth_code       TEXT,
    mti             CHAR(4),                   -- ISO 8583 message type
    kafka_partition INT,
    kafka_offset    BIGINT,
    loaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_card_txn_time   ON card_transactions (txn_time);
CREATE INDEX IF NOT EXISTS ix_card_txn_status ON card_transactions (status, response_code);

-- Reference table for DE39 response codes (join practice)
CREATE TABLE IF NOT EXISTS response_codes (
    code        CHAR(2) PRIMARY KEY,
    description TEXT NOT NULL,
    category    TEXT NOT NULL
);

INSERT INTO response_codes (code, description, category) VALUES
    ('00', 'Approved',            'approval'),
    ('05', 'Do Not Honor',        'issuer decline'),
    ('41', 'Lost Card',           'fraud / pick-up'),
    ('43', 'Stolen Card',         'fraud / pick-up'),
    ('51', 'Insufficient Funds',  'issuer decline'),
    ('54', 'Expired Card',        'card status'),
    ('59', 'Suspected Fraud',     'fraud')
ON CONFLICT (code) DO NOTHING;
