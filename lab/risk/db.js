const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool(); // PGHOST / PGUSER / PGPASSWORD / PGDATABASE

async function applySchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Run fn(client) inside a transaction.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function loadRules(q = pool) {
  const { rows } = await q.query('SELECT * FROM fraud_rules WHERE enabled');
  return Object.fromEntries(rows.map((r) => [r.rule_id, r]));
}

// Accepts "1117", "•••• 1117" or "**** 1117" and returns the simulator's mask format.
function normalizeCard(input) {
  const m = String(input || '').match(/(\d{4})\s*$/);
  return m ? `•••• ${m[1]}` : null;
}

module.exports = { pool, applySchema, withTx, loadRules, normalizeCard };
