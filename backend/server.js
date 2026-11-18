const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const bodyParser = require('body-parser');
const {
  EMVTags, ISO8583Message, EMVTransaction, isCardExpired, simNow,
  currencyNumeric, CURRENCIES, buildFollowUpMessage
} = require('./emv-iso8583');
const { FAULTS, listFaults, buildTrace } = require('./apdu-trace');
const decoder = require('./emv-decoder');

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
          iso8583_message TEXT,
          iso8583_response TEXT
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
          timestamp TEXT,
          iso8583_message TEXT
        )
      `, (err) => {
        if (err) reject(err);
      });

      // Reversals: one per transaction (0400). An APPROVED transaction with no refunds can be
      // reversed; its status becomes REVERSED, so it can't then be refunded or reversed again.
      db.run(`
        CREATE TABLE IF NOT EXISTS reversals (
          id TEXT PRIMARY KEY,
          transaction_id TEXT NOT NULL UNIQUE,
          amount_minor INTEGER NOT NULL,
          timestamp TEXT,
          iso8583_message TEXT
        )
      `, (err) => {
        if (err) reject(err);
      });

      // APDU traces: one per transaction (card <-> terminal dialogue, host events, terminal decision).
      // Kept out of the transactions table so existing rows and responses keep their shape.
      db.run(`
        CREATE TABLE IF NOT EXISTS apdu_traces (
          transaction_id TEXT PRIMARY KEY,
          fault TEXT,
          trace TEXT
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
  const { card_number, exp_date, cvv, amount, currency = 'USD', merchant_id = 'MERCHANT01', description = 'Payment', fault } = req.body;

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

  // DE49 comes from the request's currency (ISO 4217 alpha), 2-decimal currencies only
  if (currencyNumeric(currency) === null) {
    return res.status(400).json({ error: `Unsupported currency (supported: ${Object.keys(CURRENCIES).join(', ')})` });
  }
  const currencyCode = currency.trim().toUpperCase();

  // Opt-in fault injection (see GET /api/faults). Absent/empty = normal processing.
  const faultName = fault === undefined || fault === null || fault === '' ? null : String(fault).trim().toLowerCase();
  if (faultName && !FAULTS[faultName]) {
    return res.status(400).json({ error: `Unknown fault (supported: ${Object.keys(FAULTS).join(', ')})` });
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
        cardBrand.toLowerCase(),
        'contact',
        { currency: currencyCode, merchantId: merchant_id, now: simNow() }
      );

      let status, responseCode, declineReason, authCode;
      const expired = !row && isCardExpired(exp_date);

      if (row) {
        status = 'DECLINED';
        responseCode = row.response_code;
        declineReason = row.decline_reason;
        authCode = null;
      } else if (expired) {
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

      // Card <-> terminal trace around the host decision. With no fault (or a fault that can't
      // apply) the trace only explains the decision above; it never changes it.
      const preTags = transaction.getEMVData().tags;
      const trace = buildTrace({
        transactionId,
        scheme: cardBrand.toLowerCase(),
        aid: preTags['9F06'].value,
        pan: cleanCardNumber,
        exp: exp_date,
        amountMinor: parseAmountMinor(amount),
        currencyNumeric: currencyNumeric(currencyCode),
        country: preTags['9F1A'].value,
        date: preTags['9A'].value,
        un: preTags['9F37'].value,
        stan: transaction.stan,
        cryptogram: preTags['9F26'].value,
        expired: Boolean(expired),
        host: { responseCode },
        fault: faultName,
        now: simNow()
      });

      const faultApplied = Boolean(faultName && trace.fault_applied);
      if (faultApplied) {
        status = trace.outcome.status;
        responseCode = trace.outcome.response_code;
        declineReason = FAULT_DECLINE_REASONS[status] || FAULT_DECLINE_REASONS[responseCode] || declineReason;
        if (responseCode !== '00') authCode = null;
      }

      // B2: DE55 95/9B carry the terminal's results at 1st GENERATE AC, as in the trace.
      if (trace.first_gen_ac) transaction.setTerminalResults(trace.first_gen_ac);

      // DEF-002: DE39 and tag 8A must reflect the decision, not a hard-coded 00.
      // The auth code becomes DE38 in the 0110 response.
      if (responseCode) transaction.setAuthorizationResult(responseCode, authCode);

      // malformed_tlv: the packer drops the last 2 bytes of DE55 in the 0100 (emv.tlv_hex stays intact)
      if (faultApplied && faultName === 'malformed_tlv') {
        const de55 = transaction.iso8583Message.fields['55'];
        transaction.iso8583Message.fields['55'] = de55.slice(0, -4);
      }

      const emvData = transaction.getEMVData();
      const terminated = status === 'TERMINATED';
      const noHostResponse = terminated || (faultApplied && faultName === 'host_timeout');
      const isoData = terminated ? null : transaction.getISO8583Data();
      const isoResponse = noHostResponse ? null : transaction.getResponseISO8583Data();
      const msgOut = (m) => (m ? { mti: m.mti, fields: m.fields, hex_message: m.hex_message } : null);

      // Store in database
      db.run(
        `INSERT INTO transactions (
          id, card_number_masked, card_brand, exp_date, amount,
          currency, merchant_id, description, status, response_code,
          auth_code, emv_tags, iso8583_message, iso8583_response
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          maskCardNumber(cleanCardNumber),
          cardBrand,
          exp_date,
          amount,
          currencyCode,
          merchant_id,
          description,
          status,
          responseCode,
          authCode,
          JSON.stringify(emvData),
          JSON.stringify(isoData),
          JSON.stringify(isoResponse)
        ],
        (err) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to store transaction' });
          }

          const storedTrace = {
            interface: 'contact',
            scheme: cardBrand.toLowerCase(),
            aid: preTags['9F06'].value,
            fault: faultName ? { name: faultName, applied: faultApplied, note: trace.fault_note } : null,
            outcome: { ...trace.outcome, status, response_code: responseCode },
            summary: trace.summary,
            steps: trace.steps,
            log: trace.log
          };

          db.run('INSERT INTO apdu_traces (transaction_id, fault, trace) VALUES (?, ?, ?)',
            [transactionId, faultName, JSON.stringify(storedTrace)], (errT) => {
              if (errT) {
                return res.status(500).json({ error: 'Failed to store APDU trace' });
              }

              const body = {
                success: status === 'APPROVED',
                transaction_id: transactionId,
                status: status,
                response_code: responseCode,
                decline_reason: declineReason,
                auth_code: authCode,
                amount: amount,
                currency: currencyCode,
                timestamp: timestamp,
                card_masked: maskCardNumber(cleanCardNumber),
                card_brand: cardBrand,
                emv: {
                  tags: emvData.tags,
                  tlv_hex: emvData.tlv_hex
                },
                iso8583: msgOut(isoData),
                iso8583_response: msgOut(isoResponse)
              };

              // Default path: the response is exactly as before. Fault requests get extra keys.
              if (!faultName) return res.json(body);

              body.fault = {
                name: faultName,
                applied: faultApplied,
                description: FAULTS[faultName].description,
                note: trace.fault_note
              };
              body.apdu_trace = `/api/transactions/${transactionId}/apdu-trace`;

              if (!(faultApplied && trace.outcome.reversal_required)) return res.json(body);

              // Terminal-initiated reversal (0400) for an auth the card or host flow did not complete
              const amountMinor = parseAmountMinor(amount);
              const reversalId = uuidv4();
              const revIso = buildFollowUpMessage({
                mti: '0400',
                processingCode: '000000',
                amountMinor,
                originalTransactionId: transactionId,
                originalFields: isoData.fields
              });
              db.run('INSERT INTO reversals (id, transaction_id, amount_minor, timestamp, iso8583_message) VALUES (?, ?, ?, ?, ?)',
                [reversalId, transactionId, amountMinor, new Date().toISOString(), JSON.stringify(revIso)], (errR) => {
                  if (errR) {
                    return res.status(500).json({ error: 'Failed to store reversal' });
                  }
                  body.reversal = { reversal_id: reversalId, reason: 'terminal_initiated', iso8583: revIso };
                  res.json(body);
                });
            });
        }
      );
    }
  );
});

// Decline reasons for fault outcomes (by status first, then by response code)
const FAULT_DECLINE_REASONS = {
  TERMINATED: 'Application not found on card (SELECT returned 6A82); transaction terminated',
  TIMEOUT_REVERSED: 'Unable to go online (host timeout); authorization reversed',
  DECLINED_BY_CARD: 'Card declined after issuer approval (issuer authentication failed); authorization reversed',
  CARD_REMOVED_REVERSED: 'Card removed before completion; authorization reversed',
  '30': 'Format error (ICC data could not be parsed)',
  '75': 'Allowable number of PIN tries exceeded',
  '91': 'Issuer or switch inoperative',
  '96': 'System malfunction'
};

// Stored JSON columns -> objects
function parseRow(row) {
  return {
    ...row,
    emv_tags: JSON.parse(row.emv_tags),
    iso8583_message: JSON.parse(row.iso8583_message),
    iso8583_response: row.iso8583_response ? JSON.parse(row.iso8583_response) : null
  };
}

// Get transaction history (must be registered before /:id, or Express matches "history" as an id)
app.get('/api/transactions/history', (req, res) => {
  db.all(
    'SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 50',
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        transactions: rows.map(parseRow)
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

      res.json(parseRow(row));
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
    'SELECT id, iso8583_message, iso8583_response FROM transactions WHERE id = ?',
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
        iso8583: JSON.parse(row.iso8583_message),
        response: row.iso8583_response ? JSON.parse(row.iso8583_response) : null
      });
    }
  );
});

// Refunds (DEF-007): APPROVED transactions only, persisted, total capped at the original amount.
// Body (optional): { "amount": 25.50 }. Omitted = refund whatever is still refundable.
// Refunds and reversals are serialized in-process so two concurrent requests can't both pass
// the cap/status checks. Each refund builds a 0200 (DE3 200000); a reversal builds a 0400.
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
          const iso = buildFollowUpMessage({
            mti: '0200',
            processingCode: '200000',
            amountMinor: requestedMinor,
            originalTransactionId: row.id,
            originalFields: JSON.parse(row.iso8583_message).fields
          });
          db.run('INSERT INTO refunds (id, transaction_id, amount, amount_minor, timestamp, iso8583_message) VALUES (?, ?, ?, ?, ?, ?)',
            [refundId, row.id, requestedMinor / 100, requestedMinor, timestamp, JSON.stringify(iso)], (err3) => {
              if (err3) return reply(500, { error: 'Failed to store refund' });
              const leftMinor = remainingMinor - requestedMinor;
              reply(200, {
                success: true,
                original_transaction_id: row.id,
                refund_id: refundId,
                amount: requestedMinor / 100,
                remaining_amount: leftMinor / 100,
                status: leftMinor === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
                timestamp,
                iso8583: iso
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
    db.all('SELECT id, amount, amount_minor, timestamp, iso8583_message FROM refunds WHERE transaction_id = ? ORDER BY timestamp',
      [row.id], (err2, refunds) => {
        if (err2) return res.status(500).json({ error: 'Database error' });
        const refundedMinor = refunds.reduce((t, r) => t + r.amount_minor, 0);
        res.json({
          transaction_id: row.id,
          refunds: refunds.map(({ id, amount, timestamp, iso8583_message }) => ({
            refund_id: id, amount, timestamp, iso8583: iso8583_message ? JSON.parse(iso8583_message) : null
          })),
          total_refunded: refundedMinor / 100,
          remaining_amount: (Math.round(Number(row.amount) * 100) - refundedMinor) / 100
        });
      });
  });
});

// Reverse an APPROVED authorization (0400). Not allowed once any refund exists: use refunds then.
app.post('/api/transactions/:id/reversal', (req, res) => {
  withRefundLock((release) => {
    const reply = (code, body) => { release(); res.status(code).json(body); };

    db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id], (err, row) => {
      if (err) return reply(500, { error: 'Database error' });
      if (!row) return reply(404, { error: 'Transaction not found' });
      if (row.status !== 'APPROVED') {
        return reply(422, { error: 'Only APPROVED transactions can be reversed', status: row.status });
      }

      db.get('SELECT COUNT(*) AS n FROM refunds WHERE transaction_id = ?', [row.id], (err2, c) => {
        if (err2) return reply(500, { error: 'Database error' });
        if (c.n > 0) return reply(409, { error: 'Transaction has refunds and cannot be reversed' });

        const amountMinor = Math.round(Number(row.amount) * 100);
        const reversalId = uuidv4();
        const timestamp = new Date().toISOString();
        const iso = buildFollowUpMessage({
          mti: '0400',
          processingCode: '000000',
          amountMinor,
          originalTransactionId: row.id,
          originalFields: JSON.parse(row.iso8583_message).fields
        });

        db.run('INSERT INTO reversals (id, transaction_id, amount_minor, timestamp, iso8583_message) VALUES (?, ?, ?, ?, ?)',
          [reversalId, row.id, amountMinor, timestamp, JSON.stringify(iso)], (err3) => {
            if (err3) return reply(500, { error: 'Failed to store reversal' });
            db.run("UPDATE transactions SET status = 'REVERSED' WHERE id = ?", [row.id], (err4) => {
              if (err4) return reply(500, { error: 'Failed to update transaction' });
              reply(200, {
                success: true,
                original_transaction_id: row.id,
                reversal_id: reversalId,
                amount: amountMinor / 100,
                status: 'REVERSED',
                timestamp,
                iso8583: iso
              });
            });
          });
      });
    });
  });
});

// APDU trace for a transaction: C-APDU/R-APDU steps, host events, TVR/TSI/CVM/CID explained,
// a logcat-style log, and a DE55 required-tag check of the 0100 actually sent.
app.get('/api/transactions/:id/apdu-trace', (req, res) => {
  db.get('SELECT t.id, t.iso8583_message, a.trace FROM transactions t LEFT JOIN apdu_traces a ON a.transaction_id = t.id WHERE t.id = ?',
    [req.params.id], (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (!row) return res.status(404).json({ error: 'Transaction not found' });
      if (!row.trace) return res.status(404).json({ error: 'No APDU trace for this transaction' });
      const iso = JSON.parse(row.iso8583_message);
      const de55 = iso && iso.fields && iso.fields['55'] ? iso.fields['55'].value : null;
      res.json({
        transaction_id: row.id,
        ...JSON.parse(row.trace),
        de55_check: de55 ? decoder.checkDE55(de55) : null
      });
    });
});

// Fault catalogue for POST /api/transactions/process { ..., "fault": "<name>" }
app.get('/api/faults', (req, res) => {
  res.json({ faults: listFaults() });
});

// Decoder for support work. Any subset of: tvr, tsi, cvm_results, cid, sw, cvm_list, tlv_hex
// (decoded + explained), de55 (required-tag check), log (APDU log text).
app.post('/api/tools/emv-decode', (req, res) => {
  const b = req.body || {};
  const jobs = {
    tvr: decoder.decodeTVR, tsi: decoder.decodeTSI, cvm_results: decoder.decodeCVMResults, cid: decoder.decodeCID,
    sw: decoder.decodeSW, cvm_list: decoder.decodeCVMList, tlv_hex: decoder.explainTLV, de55: decoder.checkDE55, log: decoder.parseApduLog
  };
  const asked = Object.keys(jobs).filter((k) => typeof b[k] === 'string' && b[k].trim() !== '');
  if (asked.length === 0) {
    return res.status(400).json({ error: `Nothing to decode (send any of: ${Object.keys(jobs).join(', ')})` });
  }
  const out = {};
  for (const k of asked) {
    try { out[k] = jobs[k](b[k]); } catch (e) { out[k] = { error: e.message }; }
  }
  res.json(out);
});

// Reset database
app.post('/api/admin/reset', (req, res) => {
  db.run('DELETE FROM apdu_traces');
  db.run('DELETE FROM reversals');
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
  console.log('  GET  /api/transactions/:id/refunds    - List refunds for a transaction');
  console.log('  POST /api/transactions/:id/reversal   - Reverse an APPROVED auth with no refunds (0400)');
  console.log('  GET  /api/transactions/:id/apdu-trace - Card/terminal APDU trace, TVR/TSI/CVM/CID explained\n');
  console.log('🧰 SUPPORT TOOLS:');
  console.log('  GET  /api/faults                      - Fault catalogue (opt-in "fault" on /process)');
  console.log('  POST /api/tools/emv-decode            - Decode TVR/TSI/CVM/CID/SW/TLV/DE55/APDU log\n');
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
