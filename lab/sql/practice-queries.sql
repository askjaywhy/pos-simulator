-- POS Lab: SQL practice for backend data validation.
-- Connect:  docker exec -it pos-postgres psql -U poslab -d poslab
--   (or any SQL client: localhost:5432, user/pass poslab/poslab)

-- 1. What landed, by status and response code
SELECT status, response_code, response_text, COUNT(*) AS txns, SUM(amount) AS amount
FROM card_transactions
GROUP BY status, response_code, response_text
ORDER BY txns DESC;

-- 2. Approval rate by brand
SELECT card_brand,
       COUNT(*) AS txns,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'APPROVED') / COUNT(*), 1) AS approval_pct
FROM card_transactions
GROUP BY card_brand
ORDER BY txns DESC;

-- 3. Data quality: approvals must have an auth code; declines must not
SELECT id, status, response_code, auth_code
FROM card_transactions
WHERE (status = 'APPROVED' AND (auth_code IS NULL OR response_code <> '00'))
   OR (status = 'DECLINED' AND (auth_code IS NOT NULL OR response_code = '00'));
-- expected: 0 rows

-- 4. Referential check: every response code exists in the reference table
SELECT DISTINCT t.response_code
FROM card_transactions t
LEFT JOIN response_codes r ON r.code = t.response_code
WHERE r.code IS NULL;
-- expected: 0 rows

-- 5. Kafka delivery: duplicates and gaps per partition
SELECT kafka_partition,
       COUNT(*) AS rows_loaded,
       MIN(kafka_offset) AS first_offset,
       MAX(kafka_offset) AS last_offset,
       MAX(kafka_offset) - MIN(kafka_offset) + 1 - COUNT(*) AS offset_gaps
FROM card_transactions
GROUP BY kafka_partition
ORDER BY kafka_partition;

-- 6. Latency: time from transaction to load
SELECT ROUND(AVG(EXTRACT(EPOCH FROM (loaded_at - txn_time)))::numeric, 2) AS avg_seconds,
       ROUND(MAX(EXTRACT(EPOCH FROM (loaded_at - txn_time)))::numeric, 2) AS max_seconds
FROM card_transactions;

-- 7. Velocity preview (fraud week): cards with 3+ transactions in any 1-minute window
SELECT card_masked, date_trunc('minute', txn_time) AS minute, COUNT(*) AS txns
FROM card_transactions
GROUP BY card_masked, date_trunc('minute', txn_time)
HAVING COUNT(*) >= 3
ORDER BY txns DESC;
