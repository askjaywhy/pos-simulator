# POS Simulator with EMV Tags & ISO 8583

A comprehensive payment processing simulator with full EMV (Europay, MasterCard, Visa) tag support and ISO 8583 message format implementation for testing and development.

## 🧪 QA Lab: payments test platform built around the simulator

The [`lab/`](lab/) folder turns the simulator into an end-to-end payments QA environment. It runs in Docker, and the simulator code is unchanged.

| Area | What it does | Tests |
|---|---|---|
| **Event pipeline** | Transactions stream through **Kafka** (keyed by card) to separate **Postgres** and **Splunk** consumer groups, with at-least-once, idempotent delivery | Source-to-target reconciliation (`verify`): 12 checks; crash-recovery test with no loss or duplicates |
| **Fraud & chargebacks** | Rules engine (velocity, high amount, lost/stolen auto-block, approvals on blocked cards), analyst review, and the full dispute lifecycle through arbitration with Visa / Mastercard / Amex / Discover reason codes | `fraud-scenarios`: 39 checks + 12 unit tests |
| **Java test suite** | **REST Assured** API and JSON Schema contract tests, **Cucumber** BDD chargeback scenarios, **Selenium** Page Object UI tests verified against the API | 54 tests, all passing |
| **Monitoring** | Splunk dashboards for approval rate, declines by DE39, fraud alerts, rule precision and chargeback outcomes | SQL data-quality checks |

### Defects found
API testing uncovered **8 defects in the simulator**, each with steps, expected vs. actual, root cause and fix, plus an automated test that fails until it's fixed. See [`lab/java-tests/DEFECTS.md`](lab/java-tests/DEFECTS.md).

| ID | Defect | Severity |
|---|---|---|
| DEF-001 | ISO 8583 DE4 loses a cent on amounts like $19.99 (floating-point `Math.floor`) | High |
| DEF-002 | DE39 is always `00`, even on declined transactions | High |
| DEF-003 | Full PAN returned by the API and stored unmasked (**fixed**: DE2 truncated to first 6 / last 4) | Critical (PCI DSS) |
| DEF-004–007 | Invalid expiry month accepted, expired card approved, negative amount approved, declined transaction refundable | Medium–High |
| DEF-008 | ISO 8583 primary bitmap wrong for data elements 9 and up | High |

### Run it
```powershell
cd lab
.\Start-Lab.ps1                                   # Kafka, Postgres, Splunk, risk service
docker compose run --rm java-tests                # REST Assured + Cucumber + Selenium (54 tests)
docker compose run --rm --build fraud-scenarios   # fraud & chargeback suite (39 checks)
docker compose run --rm verify                    # pipeline source-to-target check
```
Full guide: [`lab/README.md`](lab/README.md) · Java suite: [`lab/java-tests/README.md`](lab/java-tests/README.md)

## 📋 Quick Features

- ✅ **EMV TLV** - 23-tag dictionary; 12 scheme-flavored tags emitted in DE55 (simulated values, no real cryptogram)
- ✅ **ISO 8583** - 0100 authorization message with DE2, 4, 11, 12, 13, 39, 49 and 55, plus a 22-field reference dictionary
- ✅ **Test Cards** - 4 approval brands and 4 decline codes (05, 41, 51, 54)
- ✅ **RESTful API** - Transaction processing, history, refunds, EMV and ISO 8583 inspection
- ✅ **Interactive UI** - Terminal simulator with EMV and ISO 8583 tabs
- ✅ **Automated Tests** - Playwright API specs plus a page-object UI suite with a visual baseline
- ✅ **Agentic test kit** - Claude Code planner, generator and locator-only healer, held in check by hook guards (see below)
- ✅ **QA Lab** - Kafka/Postgres/Splunk pipeline, fraud & chargeback engine, and Java test suite (see above)

## 🚀 5-Minute Quick Start

### Prerequisites
- Node.js 18+ (`node --version`)
- Ports 3000 and 3001 available

### Option A: One-click launcher (Windows)
```powershell
.\START_POS_SIMULATOR.bat          # backend, UI and a tests window
.\START_POS_SIMULATOR.bat test     # same, then runs the ready test suite
```
The launcher checks Node and the ports, then opens three windows: backend (:3001), UI (:3000) and tests.

### Option B: Manual
```bash
cd backend && npm install && npm start     # terminal 1: API on :3001
node scripts/serve-ui.js                   # terminal 2: UI on :3000
```
The UI is served by a small Node static server. `python -m http.server` is not used, because on Windows it can send `index.html` with the wrong content type.

### Step 4: Open Browser
Navigate to: **http://localhost:3000**

### Step 5: Test a Transaction
1. Enter test card: `4111 1111 1111 1111`
2. Exp: `12/28`
3. CVV: `123`
4. Amount: `99.99`
5. Click **PROCESS TRANSACTION**
6. View **EMV Tags** and **ISO 8583** tabs

## 📁 Project Structure

```
pos-simulator/
├── backend/
│   ├── package.json          # Dependencies (Express, SQLite, uuid, cors)
│   ├── server.js             # Express API server
│   ├── emv-iso8583.js        # Core EMV/ISO 8583 classes
│   └── node_modules/         # Installed packages
│
├── frontend/
│   └── index.html            # Interactive terminal UI
│
├── scripts/                  # serve-ui.js (UI on :3000) and the launcher's run-*.ps1 windows
│
├── tests/
│   ├── *.spec.js             # API specs (EMV, ISO 8583, transactions, history)
│   ├── support/cards.js      # Shared test data (card expiry)
│   ├── ui/pages/             # TerminalPage page object (all UI locators)
│   ├── ui/agent/             # Agent-built UI specs + visual baseline
│   └── playwright.config.js  # Test configuration
│
├── specs/                    # Test plans written by the planner agent
├── .claude/                  # Agents and guard hooks (see Agentic test kit)
├── CLAUDE.md                 # Rules every agent follows
│
└── lab/                      # QA lab (Docker): Kafka, Postgres, Splunk,
    ├── services/             #   pipeline producer/consumers, traffic, verify
    ├── risk/                 #   fraud engine, chargeback API, risk console
    └── java-tests/           #   REST Assured, Cucumber, Selenium, DEFECTS.md
```

## 🏗️ Architecture

### Backend (Node.js + Express)
- **server.js** - RESTful API with 11 endpoints
- **emv-iso8583.js** - Core payment processing module
  - `EMVTags` class - Manages 25+ EMV tags with TLV format
  - `ISO8583Message` class - Builds ISO 8583 messages with hex output
  - `EMVTransaction` class - Complete transaction processing
- **SQLite** - In-memory transaction database

### Frontend (Vanilla HTML/CSS/JS)
- Single-page application (no build step required)
- Card processing form with test card selector
- Real-time EMV tag and ISO 8583 field display
- Transaction history viewer
- Copy-to-clipboard functionality

### Tests (Playwright)
- **API layer:** EMV tags, ISO 8583 fields, Field 55 inspection, approvals, declines, history, health
- **UI layer:** page object (`tests/ui/pages/TerminalPage.js`) plus specs for sales, every test card, form validation, backend-down and timeout handling, and a visual baseline
- `npm run test:ready` from `tests/` runs the ready suite

### Agentic test kit (Claude Code)
- **Agents:** a test planner (writes `specs/`), a generator (builds page objects and specs) and a healer that may fix **locators only**. It classifies each failure as LOCATOR, TIMING, ASSERTION or ENVIRONMENT, and ASSERTION failures are reported, never "fixed".
- **Guard hooks** (`.claude/hooks/`) enforce this in the harness, not in a prompt:
  - Agents can write only to `tests/`, `specs/` and `heal-log/`.
  - Existing `expect()` lines can't change.
  - No skips, retries or timeouts.
  - No shell writes to `backend/` or `frontend/`.
  - No destructive git.
  - Visual baselines update only after a one-time human approval.
- **Audit:** every healer edit is logged to `heal-log/heals.jsonl`. The guards have 25 self-tests (`npm run test:guard`) and were verified live in Claude Code.

## 🔌 API Endpoints

### EMV Reference
```bash
GET /api/emv-tags
# Response: { tags: {...}, total: 25 }
```

### ISO 8583 Reference
```bash
GET /api/iso8583-fields
# Response: { fields: {...}, total: 64 }
```

### Process Transaction
```bash
POST /api/transactions/process
# Body: { card_number, exp_date, cvv, amount, currency, merchant_id, description }
# Response: { success, transaction_id, status, emv, iso8583, ... }
```

### Get Transaction EMV Data
```bash
GET /api/transactions/{id}/emv
# Response: { transaction_id, emv: { tags, tlv_hex } }
```

### Get Transaction ISO 8583 Data
```bash
GET /api/transactions/{id}/iso8583
# Response: { transaction_id, iso8583: { mti, fields, hex_message } }
```

### Full Endpoint List
```bash
# Reference Data
GET  /api/emv-tags                          # 25+ EMV tags
GET  /api/iso8583-fields                    # 64+ ISO 8583 fields
GET  /api/test-cards                        # Test card definitions

# Transaction Processing
POST /api/transactions/process               # Process payment
GET  /api/transactions/history               # Transaction list
GET  /api/transactions/:id                   # Transaction details
GET  /api/transactions/:id/emv                # EMV tag data
GET  /api/transactions/:id/iso8583           # ISO 8583 data
POST /api/transactions/:id/refund            # Refund transaction

# Utilities
GET  /api/health                             # Health check
POST /api/admin/reset                        # Reset database
```

## 💳 Test Cards

| Card | Status | Use Case |
|------|--------|----------|
| 4111 1111 1111 1111 | ✓ Approved | Standard VISA |
| 5555 5555 5555 4444 | ✓ Approved | MasterCard |
| 3782 822463 10005 | ✓ Approved | American Express |
| 6011 1111 1111 1117 | ✓ Approved | Discover |
| 4000 0000 0000 0002 | ✗ Declined | Insufficient Funds |
| 4000 0000 0000 9987 | ✗ Declined | Lost Card |
| 4000 0000 0000 0010 | ✗ Declined | Expired Card |
| 5105 1051 0510 5100 | ✗ Declined | Generic Decline |

## 🧪 Running Tests

### Install Test Dependencies
```bash
cd tests
npm install
```

### Run All Tests
```bash
npm test
```

### Run Tests with Browser Visible
```bash
npm run test:headed
```

### Run Specific Test
```bash
npm test -- --grep "EMV Tags"
```

### Debug Tests
```bash
npm run test:debug
```

### View Test Report
```bash
npx playwright show-report
```

## 🔍 EMV Tags Reference

| Tag | Name | Category | Length |
|-----|------|----------|--------|
| 9F06 | Application Dedicated File (AID) | Application | Variable |
| 9F26 | Cryptogram | Cryptography | 8 bytes |
| 95 | Terminal Verification Results (TVR) | Security | 5 bytes |
| 9B | Transaction Status Information (TSI) | Security | 2 bytes |
| 9F27 | Cryptogram Information Data | Cryptography | 1 byte |
| ... | ... | ... | ... |

**23 tags in the dictionary; 12 are emitted in DE55. Values are simulated: the cryptogram and unpredictable number are fixed samples.**

## 📊 ISO 8583 Fields Reference

| Field | Name | Type | Length | Category |
|-------|------|------|--------|----------|
| 0 | Message Type Indicator (MTI) | numeric | 4 | Control |
| 2 | Primary Account Number (PAN) | numeric | 19 | Card |
| 4 | Amount, Transaction | numeric | 12 | Transaction |
| 11 | System Trace Audit Number (STAN) | numeric | 6 | Transaction |
| 39 | Response Code | numeric | 2 | Response |
| ... | ... | ... | ... | ... |

**22 fields in the reference dictionary. The 0100 message sets DE2 (truncated), 4, 11, 12, 13, 39, 49 and 55. Known gaps (DE39 on declines, bitmap) are tracked in the [defect log](lab/java-tests/DEFECTS.md).**

## 🔐 Compliance & Security

- ✅ **Luhn Algorithm** - Card number validation
- ✅ **TLV Format** - Tag-Length-Value encoding and decoding for DE55
- ✅ **Hex Output** - EMV TLV and ISO 8583 message shown in hex
- ℹ️ **Simulator only** - Not EMV- or network-certified; cryptograms are not real, and STAN is random, not guaranteed unique
- ✅ **PCI** - Test cards only; the PAN is truncated to first 6 / last 4 in DE2, `hex_message` and storage ([DEF-003](lab/java-tests/DEFECTS.md), fixed)

## 🛠️ Troubleshooting

### Backend Won't Start
```bash
# Check if port 3001 is in use
netstat -ano | findstr :3001

# If port is blocked, change PORT:
PORT=3002 npm start
```

### Frontend Can't Connect to Backend
```bash
# Verify backend is running
curl http://localhost:3001/api/health

# Check CORS is enabled (it is by default)
```

### Tests Won't Run
```bash
# Install Playwright browsers
cd tests
npx playwright install

# Try running tests again
npm test
```

### Database Locked Error
- The in-memory database is single-process
- Close other instances and restart backend

## 📚 Documentation

| Document | Purpose | Time |
|----------|---------|------|
| [README.md](README.md) | Overview & quick start | 5 min |
| [INSTALL.md](INSTALL.md) | Installation | 5 min |
| [SETUP_GUIDE.md](SETUP_GUIDE.md) | Detailed setup guide | 10 min |
| [ARCHITECTURE.txt](ARCHITECTURE.txt) | Architecture notes | 10 min |
| [lab/README.md](lab/README.md) | QA lab: pipeline, fraud module, exercises | 15 min |
| [lab/java-tests/DEFECTS.md](lab/java-tests/DEFECTS.md) | Defect log | 10 min |

## 🚀 Next Steps

### For QA/Testing
1. Review test cases in `tests/emv-iso8583.spec.js`
2. Run full test suite: `npm test`
3. Add custom decline rules to `backend/server.js`
4. Create test scenarios for edge cases

### For Development
1. Modify EMV tags in `backend/emv-iso8583.js`
2. Add new ISO 8583 fields
3. Extend API endpoints in `backend/server.js`
4. Enhance frontend UI in `frontend/index.html`

### For Integration
1. Export database transactions via API
2. Integrate with your payment gateway
3. Customize decline rules based on business logic
4. Add additional security validations

## 📞 Support

- Check the documentation listed above
- Review test cases for usage examples
- Verify backend is running on port 3001
- Check browser console for errors

## 📝 License

Test/Development Use Only - Do not use with real card data

---

**Version:** 1.0.0  
**Last Updated:** 2026-10-11  
**Status:** Test/development tool. See the [defect log](lab/java-tests/DEFECTS.md)
