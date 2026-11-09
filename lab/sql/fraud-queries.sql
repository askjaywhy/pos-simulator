-- POS Lab: fraud & chargeback SQL practice.
-- docker exec -it pos-postgres psql -U poslab -d poslab

-- 1. Alert volume and outcomes by rule (rule precision = confirmed / reviewed)
SELECT rule_id,
       COUNT(*) AS alerts,
       COUNT(*) FILTER (WHERE status = 'CONFIRMED_FRAUD') AS confirmed,
       COUNT(*) FILTER (WHERE status = 'FALSE_POSITIVE')  AS false_positive,
       COUNT(*) FILTER (WHERE status = 'OPEN')            AS open,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'CONFIRMED_FRAUD')
             / NULLIF(COUNT(*) FILTER (WHERE status <> 'OPEN'), 0), 1) AS precision_pct
FROM fraud_alerts GROUP BY rule_id ORDER BY alerts DESC;

-- 2. Every scored transaction exists in card_transactions (engine vs pipeline reconciliation)
SELECT s.transaction_id FROM fraud_scored_txns s
LEFT JOIN card_transactions t ON t.id = s.transaction_id
WHERE t.id IS NULL;
-- expected: 0 rows once postgres-sink has caught up

-- 3. Control check: approved transactions on cards while they were blocked
SELECT t.id, t.card_masked, t.amount, t.txn_time, b.block_id, b.reason
FROM card_transactions t
JOIN card_blocks b ON b.card_masked = t.card_masked
 AND t.txn_time >= b.created_at AND (b.released_at IS NULL OR t.txn_time < b.released_at)
WHERE t.status = 'APPROVED'
ORDER BY t.txn_time DESC;
-- each row should have a BLOCKED_CARD_ACTIVITY alert (query 4)

-- 4. ...and here's the proof: blocked-card approvals with no alert (expected 0 rows)
SELECT t.id, t.card_masked, t.txn_time
FROM card_transactions t
JOIN card_blocks b ON b.card_masked = t.card_masked
 AND t.txn_time >= b.created_at AND (b.released_at IS NULL OR t.txn_time < b.released_at)
LEFT JOIN fraud_alerts a ON a.transaction_id = t.id AND a.rule_id = 'BLOCKED_CARD_ACTIVITY'
WHERE t.status = 'APPROVED' AND a.alert_id IS NULL;

-- 5. Dispute pipeline by state with money at risk
SELECT state, COUNT(*) AS disputes, SUM(dispute_amount) AS amount,
       COUNT(*) FILTER (WHERE respond_by < CURRENT_DATE AND closed_at IS NULL) AS past_due
FROM disputes GROUP BY state ORDER BY state;

-- 6. Data integrity: closed disputes must have liability; open ones must not
SELECT dispute_id, state, liability, closed_at FROM disputes
WHERE (closed_at IS NOT NULL AND liability IS NULL)
   OR (closed_at IS NULL AND liability IS NOT NULL)
   OR (state LIKE 'CLOSED_%') <> (closed_at IS NOT NULL);
-- expected: 0 rows

-- 7. Audit trail is continuous: each event starts where the previous one ended
SELECT e.dispute_id, e.event_id, e.action, e.from_state, prev.to_state AS previous_to_state
FROM dispute_events e
JOIN LATERAL (SELECT to_state FROM dispute_events p WHERE p.dispute_id = e.dispute_id AND p.event_id < e.event_id
              ORDER BY p.event_id DESC LIMIT 1) prev ON true
WHERE e.from_state IS DISTINCT FROM prev.to_state;
-- expected: 0 rows

-- 8. Dispute amount never exceeds the original transaction (source-to-target check)
SELECT d.dispute_id, d.dispute_amount, t.amount
FROM disputes d JOIN card_transactions t ON t.id = d.transaction_id
WHERE d.dispute_amount > t.amount OR d.txn_amount <> t.amount;
-- expected: 0 rows

-- 9. Chargeback ratio by merchant (networks monitor this; ~1% is a common warning level)
SELECT t.merchant_id,
       COUNT(DISTINCT t.id) AS approved_txns,
       COUNT(DISTINCT d.dispute_id) AS chargebacks,
       ROUND(100.0 * COUNT(DISTINCT d.dispute_id) / NULLIF(COUNT(DISTINCT t.id), 0), 2) AS chargeback_pct
FROM card_transactions t LEFT JOIN disputes d ON d.transaction_id = t.id
WHERE t.status = 'APPROVED'
GROUP BY t.merchant_id HAVING COUNT(DISTINCT d.dispute_id) > 0
ORDER BY chargeback_pct DESC;
