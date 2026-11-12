const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const bodyParser = require('body-parser');
const { EMVTags, ISO8583Message, EMVTransaction, isCardExpired, simNow } = require('./emv-iso8583');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory SQLite database
const db = new sqlite3.Database(':memory:');

// Database initialization
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Create transactions table
      db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          card_number_masked TEXT,
          card_brand TEXT,
          exp_date TEXT,
          amount REAL,
          currency TEXT DEFAULT 'USD',
          merchant_id TEXT,
          description TEXT,
          status TEXT,
          response_code TEXT,
          auth_code TEXT,
          emv_tags TEXT,
          iso8583_message TEXT
        )
      `, (err) => {
        if (err) reject(err);
      });

      // Create refunds table (DEF-007): one row per refund, amounts in minor units for exact sums
      db.run(`
        CREATE TABLE IF NOT EXISTS refunds (
          id TEXT PRIMARY KEY,
          transaction_id TEXT NOT NULL,
          amount REAL,
          amount_minor INTEGER NOT NULL,
          timestamp TEXT
        )
      `, (err) => {
        if (err) reject(err);
      });

      // Create decline rules table
      db.run(`
        CREATE TABLE IF NOT EXISTS decline_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_pattern TEXT UNIQUE,
          response_code TEXT,
          decline_reason TEXT
        )
      `, (err) => {
        if (err) reject(err);
      });

      // Insert default decline rules
      const declineRules = [
        ['4000000000000002', '51', 'Insufficient Funds'],
        ['4000000000009987', '41', 'Lost Card'],
        ['4000000000000010', '54', 'Expired Card'],
        ['5105105105105100', '05', 'Generic Decline']
      ];

      declineRules.forEach(rule => {
        db.run(`
          INSERT OR IGNORE INTO decline_rules (card_pattern, response_code, decline_reason)
          VALUES (?, ?, ?)
        `, rule, (err) => {
          if (err && !err.message.includes('UNIQUE')) reject(err);
        });
      });

      resolve();
    });
  });
}

// Luhn Algorithm validation
function validateLuhn(cardNumber) {
  let sum = 0;
  let isEven = false;

  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = parseInt(cardNumber[i], 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

// Get card brand
function getCardBrand(cardNumber) {
  const cardPatterns = {
    'VISA': /^4[0-9]{12}(?:[0-9]{3})?$/,
    'MASTERCARD': /^5[1-5][0-9]{14}$/,
    'AMEX': /^3[47][0-9]{13}$/,
    'DISCOVER': /^6(?:011|5[0-9]{2})[0-9]{12}$/
  };

  for (const [brand, pattern] of Object.entries(cardPatterns)) {
    if (pattern.test(cardNumber)) return brand;
  }
  return 'UNKNOWN';
}

// Mask card number
// DEF-006: a positive decimal with at most 2 places that fits DE4 (n12, minor units).
// Checked on the decimal text, so 0.001, 19.999, -5, "abc" and 1e21 are all rejected.
// Returns the amount in minor units (cents), or null if invalid. Used by payments and refunds.
function parseAmountMinor(amount) {
  const text = typeof amount === 'number' || typeof amount === 'string' ? String(amount).trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const minor = Math.round(Number(text) * 100);
  return minor > 0 && minor <= 999999999999 ? minor : null;
}

function maskCardNumber(cardNumber) {
  return '•••• ' + cardNumber.slice(-4);
}

// Test cards for reference
const TEST_CARDS = [
  { number: '4111111111111111', exp: '12/28', cvv: '123', status: 'APPROVED', brand: 'VISA' },
  { number: '5555555555554444', exp: '12/28', cvv: '123', status: 'APPROVED', brand: 'MASTERCARD' },
  { number: '378282246310005', exp: '12/28', cvv: '123', status: 'APPROVED', brand: 'AMEX' },
  { number: '6011111111111117', exp: '12/28', cvv: '123', status: 'APPROVED', brand: 'DISCOVER' },
  { number: '4000000000000002', exp: '12/28', cvv: '123', status: 'DECLINED', reason: 'Insufficient Funds' },
  { number: '4000000000009987', exp: '12/28', cvv: '123', status: 'DECLINED', reason: 'Lost Card' }
];

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Get test cards
app.get('/api/test-cards', (req, res) => {
  res.json({ cards: TEST_CARDS });
});

// Get EMV tags reference
app.get('/api/emv-tags', (req, res) => {
  const emvTags = new EMVTags();
  res.json({ tags: emvTags.getAll(), total: Object.keys(emvTags.getAll()).length });
});

// Get ISO 8583 fields reference
app.get('/api/iso8583-fields', (req, res) => {
  const iso8583 = new ISO8583Message();
  res.json({ fields: iso8583.getFields(), total: Object.keys(iso8583.getFields()).length });
});

// Inspect field 55 for a given scheme (visa/mastercard/amex/discover)
app.get('/api/field55/inspect', (req, res) => {
  const scheme = (req.query.scheme || 'visa').toLowerCase();
  const tx = new EMVTransaction('demo', '4111111111111111', 12.34, scheme);

  res.json({
    scheme,
    emv: tx.getEMVData(),
    iso8583: tx.getISO8583Data(),
    field55: tx.getField55Pretty()
  });
});

// Process transaction
app.post('/api/transactions/process', (req, res) => {
  const { card_number, exp_date, cvv, amount, currency = 'USD', merchant_id = 'MERCHANT01', description = 'Payment' } = req.body;

  // Validation
  if (!card_number || !exp_date || !cvv || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate card number
  if (!validateLuhn(card_number.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Invalid card number (Luhn check failed)' });
  }

  // Validate expiration date
  if (!/^\d{2}\/\d{2}$/.test(exp_date)) {
    return res.status(400).json({ error: 'Invalid expiration date format (MM/YY)' });
  }

  // DEF-004: the month must be 01-12
  const expMonth = parseInt(exp_date.slice(0, 2), 10);
  if (expMonth < 1 || expMonth > 12) {
    return res.status(400).json({ error: 'Invalid expiration month (01-12)' });
  }

  // DEF-006: amount must be a positive decimal with at most 2 places that fits DE4 (see parseAmountMinor)
  if (parseAmountMinor(amount) === null) {
    return res.status(400).json({ error: 'Invalid amount: must be a positive number with at most 2 decimal places' });
  }

  const cleanCardNumber = card_number.replace(/\s/g, '');
  const cardBrand = getCardBrand(cleanCardNumber);
  const transactionId = uuidv4();
  const timestamp = new Date().toISOString();

  // Check decline rules
  db.get(
    'SELECT * FROM decline_rules WHERE card_pattern = ?',
    [cleanCardNumber],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      // Create EMV transaction
      const transaction = new EMVTransaction(
  transactionId,
  cleanCardNumber,
  amount,
  cardBrand.toLowerCase()
);

      let status, responseCode, declineReason, authCode;

      if (row) {
        status = 'DECLINED';
        responseCode = row.response_code;
        declineReason = row.decline_reason;
        authCode = null;
      } else if (isCardExpired(exp_date)) {
        // DEF-005: an exact-PAN decline rule wins; otherwise an expired card is declined 54
        status = 'DECLINED';
        responseCode = '54';
        declineReason = 'Expired Card';
        authCode = null;
      } else {
        status = 'APPROVED';
        responseCode = '00';
        declineReason = null;
        authCode = 'AUTH' + transactionId.substring(0, 6).toUpperCase();
      }

      // DEF-002: DE39 and tag 8A must reflect the decision, not a hard-coded 00
      transaction.setAuthorizationResult(responseCode);

      const emvData = transaction.getEMVData();
      const isoData = transaction.getISO8583Data();

      // Store in database
      db.run(
        `INSERT INTO transactions (
          id, card_number_masked, card_brand, exp_date, amount,
          currency, merchant_id, description, status, response_code,
          auth_code, emv_tags, iso8583_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          maskCardNumber(cleanCardNumber),
          cardBrand,
          exp_date,
          amount,
          currency,
          merchant_id,
          description,
          status,
          responseCode,
          authCode,
          JSON.stringify(emvData),
          JSON.stringify(isoData)
        ],
        (err) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to store transaction' });
          }

          res.json({
            success: status === 'APPROVED',
            transaction_id: transactionId,
            status: status,
            response_code: responseCode,
            decline_reason: declineReason,
            auth_code: authCode,
            amount: amount,
            currency: currency,
            timestamp: timestamp,
            card_masked: maskCardNumber(cleanCardNumber),
            card_brand: cardBrand,
            emv: {
              tags: emvData.tags,
              tlv_hex: emvData.tlv_hex
            },
            iso8583: {
              mti: isoData.mti,
              fields: isoData.fields,
              hex_message: isoData.hex_message
            }
          });
        }
      );
    }
  );
});

// Get transaction history (must be registered before /:id, or Express matches "history" as an id)
app.get('/api/transactions/history', (req, res) => {
  db.all(
    'SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 50',
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        transactions: rows.map(row => ({
          ...row,
          emv_tags: JSON.parse(row.emv_tags),
          iso8583_message: JSON.parse(row.iso8583_message)
        }))
      });
    }
  );
});

// Get transaction details
app.get('/api/transactions/:id', (req, res) => {
  db.get(
    'SELECT * FROM transactions WHERE id = ?',
    [req.params.id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      res.json({
        ...row,
        emv_tags: JSON.parse(row.emv_tags),
        iso8583_message: JSON.parse(row.iso8583_message)
      });
    }
  );
});

// Get transaction EMV data
app.get('/api/transactions/:id/emv', (req, res) => {
  db.get(
    'SELECT id, emv_tags FROM transactions WHERE id = ?',
    [req.params.id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      res.json({
        transaction_id: row.id,
        emv: JSON.parse(row.emv_tags)
      });
    }
  );
});

// Get transaction ISO 8583 data
app.get('/api/transactions/:id/iso8583', (req, res) => {
  db.get(
    'SELECT id, iso8583_message FROM transactions WHERE id = ?',
    [req.params.id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      res.json({
        transaction_id: row.id,
        iso8583: JSON.parse(row.iso8583_message)
      });
    }
  );
});

// Refunds (DEF-007): APPROVED transactions only, persisted, total capped at the original amount.
// Body (optional): { "amount": 25.50 }. Omitted = refund whatever is still refundable.
// Refunds are serialized in-process so two concurrent requests can't both pass the cap check.
let refundLock = Promise.resolve();
function withRefundLock(work) {
  const run = refundLock.then(() => new Promise((release) => work(release)));
  refundLock = run.catch(() => {});
  return run;
}

app.post('/api/transactions/:id/refund', (req, res) => {
  withRefundLock((release) => {
    const reply = (code, body) => { release(); res.status(code).json(body); };

    db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id], (err, row) => {
      if (err) return reply(500, { error: 'Database error' });
      if (!row) return reply(404, { error: 'Transaction not found' });
      if (row.status !== 'APPROVED') {
        return reply(422, { error: 'Only APPROVED transactions can be refunded', status: row.status });
      }

      db.get('SELECT COALESCE(SUM(amount_minor), 0) AS refunded FROM refunds WHERE transaction_id = ?',
        [row.id], (err2, sum) => {
          if (err2) return reply(500, { error: 'Database error' });

          const originalMinor = Math.round(Number(row.amount) * 100);
          const remainingMinor = originalMinor - sum.refunded;
          const body = req.body || {};
          const hasAmount = body.amount !== undefined && body.amount !== null && body.amount !== '';
          const requestedMinor = hasAmount ? parseAmountMinor(body.amount) : remainingMinor;

          if (hasAmount && requestedMinor === null) {
            return reply(400, { error: 'Invalid amount: must be a positive number with at most 2 decimal places' });
          }
          if (requestedMinor <= 0 || requestedMinor > remainingMinor) {
            return reply(409, { error: 'Refund exceeds remaining refundable amount', remaining_amount: remainingMinor / 100 });
          }

          const refundId = uuidv4();
          const timestamp = new Date().toISOString();
          db.run('INSERT INTO refunds (id, transaction_id, amount, amount_minor, timestamp) VALUES (?, ?, ?, ?, ?)',
            [refundId, row.id, requestedMinor / 100, requestedMinor, timestamp], (err3) => {
              if (err3) return reply(500, { error: 'Failed to store refund' });
              const leftMinor = remainingMinor - requestedMinor;
              reply(200, {
                success: true,
                original_transaction_id: row.id,
                refund_id: refundId,
                amount: requestedMinor / 100,
                remaining_amount: leftMinor / 100,
                status: leftMinor === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
                timestamp
              });
            });
        });
    });
  });
});

// List a transaction's refunds (DEF-007)
app.get('/api/transactions/:id/refunds', (req, res) => {
  db.get('SELECT id, amount FROM transactions WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!row) return res.status(404).json({ error: 'Transaction not found' });
    db.all('SELECT id, amount, amount_minor, timestamp FROM refunds WHERE transaction_id = ? ORDER BY timestamp',
      [row.id], (err2, refunds) => {
        if (err2) return res.status(500).json({ error: 'Database error' });
        const refundedMinor = refunds.reduce((t, r) => t + r.amount_minor, 0);
        res.json({
          transaction_id: row.id,
          refunds: refunds.map(({ id, amount, timestamp }) => ({ refund_id: id, amount, timestamp })),
          total_refunded: refundedMinor / 100,
          remaining_amount: (Math.round(Number(row.amount) * 100) - refundedMinor) / 100
        });
      });
  });
});

// Reset database
app.post('/api/admin/reset', (req, res) => {
  db.run('DELETE FROM refunds');
  db.run('DELETE FROM transactions', (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to reset database' });
    }
    res.json({ success: true, message: 'Database reset successfully' });
  });
});

// Initialize and start server
initializeDatabase().then(() => {
  console.log('✅ Connected to in-memory SQLite database');
  console.log('✅ Database schema initialized\n');
  console.log('============================================================');
  console.log('🏷️  POS Simulator Backend running on http://localhost:' + PORT);
  console.log('============================================================\n');
  console.log('🏷️  EMV TAG ENDPOINTS:');
  console.log('  GET  /api/emv-tags                    - View all EMV tags');
  console.log('  GET  /api/transactions/:id/emv        - Get transaction EMV data\n');
  console.log('📋 ISO 8583 ENDPOINTS:');
  console.log('  GET  /api/iso8583-fields              - View all ISO 8583 fields');
  console.log('  GET  /api/transactions/:id/iso8583    - Get transaction ISO 8583 format\n');
  console.log('💳 TRANSACTION ENDPOINTS:');
  console.log('  POST /api/transactions/process        - Process a payment');
  console.log('  GET  /api/transactions/history        - View transaction history');
  console.log('  GET  /api/transactions/:id            - Get transaction details');
  console.log('  POST /api/transactions/:id/refund     - Refund (APPROVED only; optional {amount}; capped)');
  console.log('  GET  /api/transactions/:id/refunds    - List refunds for a transaction\n');
  console.log('🧪 UTILITY ENDPOINTS:');
  console.log('  GET  /api/test-cards                  - Get test card numbers');
  console.log('  GET  /api/health                      - Health check');
  console.log('  POST /api/admin/reset                 - Reset database');
  console.log('============================================================\n');

  app.listen(PORT, () => {
    // Server started
    if (process.env.SIM_NOW) {
      console.log(`  SIM_NOW set: authorization date pinned to ${simNow().toISOString()}`);
    }
  });
}).catch(err => {
  console.error('❌ Failed to initialize database:', err);
  process.exit(1);
});
