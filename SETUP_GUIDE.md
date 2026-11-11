# 📋 Complete Setup Guide - POS Simulator with EMV/ISO 8583

**Time Required:** 15 minutes  
**Difficulty:** Beginner  
**Prerequisites:** Node.js, Python 3, Git (optional)

---

## ✅ Pre-Setup Verification

Run this to confirm your environment is ready:

```bash
# Check Node.js
node --version          # Should be v14 or higher
npm --version           # Should be v6 or higher

# Check Python
python3 --version       # Should be v3.6 or higher

# Check ports are available
netstat -ano | findstr :3000    # Should show nothing
netstat -ano | findstr :3001    # Should show nothing
```

---

## 🔧 Step 1: Backend Setup (5 minutes)

### 1.1 Navigate to Backend Directory
```bash
cd pos-simulator/backend
```

### 1.2 Install Dependencies
```bash
npm install
```

**What this does:**
- Installs Express (web framework)
- Installs SQLite3 (database)
- Installs CORS (cross-origin support)
- Installs body-parser (request parsing)
- Installs uuid (unique IDs)
- Total size: ~200 MB (varies by system)

**Expected output:**
```
added 69 packages in 30s
```

### 1.3 Verify Installation
```bash
npm list
```

**Should show:**
- express@4.18.2
- sqlite3@5.1.6
- uuid@9.0.0
- cors@2.8.5
- body-parser@1.20.2

---

## 🚀 Step 2: Start Backend Server (Runs Continuously)

### 2.1 Start Backend
```bash
npm start
```

### 2.2 Verify Backend is Running

**You should see:**
```
✅ Connected to in-memory SQLite database
✅ Database schema initialized

============================================================
🏷️  POS Simulator Backend running on http://localhost:3001
============================================================

🏷️  EMV TAG ENDPOINTS:
  GET  /api/emv-tags                    - View all EMV tags
  GET  /api/transactions/:id/emv        - Get transaction EMV data

📋 ISO 8583 ENDPOINTS:
  GET  /api/iso8583-fields              - View all ISO 8583 fields
  GET  /api/transactions/:id/iso8583    - Get transaction ISO 8583 format

💳 TRANSACTION ENDPOINTS:
  POST /api/transactions/process        - Process a payment
  GET  /api/transactions/history        - View transaction history
  GET  /api/transactions/:id            - Get transaction details
  POST /api/transactions/:id/refund     - Refund a transaction

🧪 UTILITY ENDPOINTS:
  GET  /api/test-cards                  - Get test card numbers
  GET  /api/health                      - Health check
  POST /api/admin/reset                 - Reset database
============================================================
```

### 2.3 Test Backend Health
Open new terminal and run:
```bash
curl http://localhost:3001/api/health
```

**Expected response:**
```json
{"status":"healthy","timestamp":"2026-10-11T20:30:00.000Z"}
```

### 2.4 Get EMV Tags
```bash
curl http://localhost:3001/api/emv-tags
```

### 2.5 Get ISO 8583 Fields
```bash
curl http://localhost:3001/api/iso8583-fields
```

**⚠️ KEEP THIS TERMINAL OPEN** - The backend must keep running

---

## 🎨 Step 3: Start Frontend Server (Runs Continuously)

### 3.1 Open New Terminal, Navigate to Frontend
```bash
cd pos-simulator/frontend
```

### 3.2 Start Python Web Server
```bash
python3 -m http.server 3000
```

**Expected output:**
```
Serving HTTP on 0.0.0.0 port 3000 ([::]:3000) ...
```

### 3.3 Verify Frontend is Accessible
```bash
curl http://localhost:3000
```

**Should return HTML content**

**⚠️ KEEP THIS TERMINAL OPEN** - The frontend must keep running

---

## 🌐 Step 4: Access the Terminal UI

### 4.1 Open Browser
Go to: **http://localhost:3000**

### 4.2 What You Should See
- **Header:** "💳 POS Terminal Simulator"
- **Status Badges:** ✓ EMV Support, ✓ ISO 8583, Backend: http://localhost:3001
- **Left Panel:** Payment form with card details
- **Right Panel:** Transaction result display

### 4.3 Process Your First Transaction

**Enter Test Card Details:**
- Card Number: `4111111111111111`
- Expiration: `12/28`
- CVV: `123`
- Amount: `99.99`

**Click:** "PROCESS TRANSACTION"

**You should see:**
- ✓ APPROVED status in green
- Transaction ID
- Auth Code
- Amount and timestamp
- Three tabs: Summary, EMV Tags, ISO 8583

### 4.4 View EMV Tags
Click **"EMV Tags"** tab to see:
- 9F06 (AID)
- 9F26 (Cryptogram)
- 95 (TVR)
- 9B (TSI)
- And more...

Each tag shows:
- Tag number
- Tag name
- Hex value

### 4.5 View ISO 8583 Message
Click **"ISO 8583"** tab to see:
- Field 0: MTI (0100)
- Field 2: PAN (4111...)
- Field 4: Amount (9999)
- Field 11: STAN (unique)
- Field 39: Response Code (00)
- And more...

Each field shows:
- Field number
- Field name
- Field value
- Field type

### 4.6 Copy Hex Data
- Click "Copy TLV Hex" to copy EMV data
- Click "Copy Message Hex" to copy ISO 8583 data
- Data is copied to your clipboard

---

## 🧪 Step 5: Run Automated Tests (Optional)

### 5.1 Open Third Terminal
Navigate to tests directory:
```bash
cd pos-simulator/tests
```

### 5.2 Install Playwright
```bash
npm install
```

### 5.3 Install Playwright Browsers
```bash
npx playwright install
```

**⚠️ First time only - downloads browser binaries (~300 MB)**

### 5.4 Run Tests
```bash
npm test
```

**What this does:**
- Runs 32+ test cases
- Tests EMV tag generation
- Tests ISO 8583 field formatting
- Tests all API endpoints
- Tests decline scenarios
- Tests edge cases

**Expected output:**
```
✓ Should approve valid transaction
✓ Should decline insufficient funds
✓ Should contain standard EMV tags
✓ Transaction response should include EMV data
✓ Should get ISO 8583 fields reference
... (32 total)

32 passed (45s)
```

### 5.5 View Test Report
```bash
npx playwright show-report
```

Opens HTML report in browser showing:
- All test results
- Pass/fail status
- Test duration
- Error details (if any)

### 5.6 Run Tests with Browser Visible
```bash
npm run test:headed
```

Shows actual browser performing tests

---

## 💻 Testing Scenarios

### Scenario 1: Approved Transaction
```
Card: 4111 1111 1111 1111
Amount: $99.99
Expected: ✓ APPROVED
```

### Scenario 2: Insufficient Funds
```
Card: 4000 0000 0000 0002
Amount: Any
Expected: ✗ DECLINED (51)
```

### Scenario 3: Lost Card
```
Card: 4000 0000 0000 9987
Amount: Any
Expected: ✗ DECLINED (41)
```

### Scenario 4: Expired Card
```
Card: 4000 0000 0000 0010
Amount: Any
Expected: ✗ DECLINED (54)
```

### Scenario 5: Large Amount
```
Card: 4111 1111 1111 1111
Amount: $999,999.99
Expected: ✓ APPROVED
```

### Scenario 6: Small Amount
```
Card: 4111 1111 1111 1111
Amount: $0.01
Expected: ✓ APPROVED
```

---

## 🔍 Verifying Installation

### Checklist - All systems running

- [ ] Backend terminal shows "POS Simulator Backend running..."
- [ ] Frontend terminal shows "Serving HTTP on 0.0.0.0 port 3000"
- [ ] Browser shows POS Terminal Simulator UI
- [ ] Can process test transaction
- [ ] EMV Tags tab shows data
- [ ] ISO 8583 tab shows data
- [ ] Can copy hex data to clipboard
- [ ] Transaction history loads

### If Any Check Fails

**Backend won't start:**
```bash
# Port 3001 might be in use
netstat -ano | findstr :3001
# Kill the process or use different port:
PORT=3002 npm start
```

**Frontend won't start:**
```bash
# Port 3000 might be in use
netstat -ano | findstr :3000
# Try different port:
python3 -m http.server 8000
```

**Backend and frontend can't communicate:**
```bash
# Test connection from frontend terminal
curl http://localhost:3001/api/health
# Should return: {"status":"healthy",...}
```

**Tests won't run:**
```bash
cd tests
npm install
npx playwright install
npm test
```

---

## 📊 Project Files Reference

### Backend Files
- `backend/package.json` - Dependencies list
- `backend/server.js` - Express API (11 endpoints)
- `backend/emv-iso8583.js` - Core module (3 classes)

### Frontend Files
- `frontend/index.html` - Single HTML file (no build needed)

### Test Files
- `tests/package.json` - Playwright dependencies
- `tests/emv-iso8583.spec.js` - 32+ test cases
- `tests/playwright.config.js` - Test configuration

### Documentation
- `README.md` - Overview & features
- `SETUP_GUIDE.md` - This file
- `API.md` - API reference (if present)

---

## 🎓 Next Steps

### For QA Engineers
1. Run all tests: `npm test`
2. Review test code in `tests/emv-iso8583.spec.js`
3. Add custom decline rules
4. Create new test scenarios

### For Developers
1. Add EMV tags in `backend/emv-iso8583.js`
2. Add ISO 8583 fields
3. Create custom API endpoints
4. Extend frontend UI

### For Integration
1. Export transactions
2. Connect to payment gateway
3. Customize decline logic
4. Add compliance checks

---

## 🆘 Troubleshooting Table

| Problem | Solution |
|---------|----------|
| Port 3001 in use | `netstat -ano \| findstr :3001` then `taskkill /PID xxx /F` |
| Port 3000 in use | Try port 8000: `python3 -m http.server 8000` |
| Backend won't start | Check Node.js: `node --version` |
| Frontend can't connect | Verify backend: `curl http://localhost:3001/api/health` |
| Tests won't run | Install browsers: `npx playwright install` |
| CORS errors | CORS is enabled by default in server.js |
| Database errors | Data is in-memory; restart backend to reset |

---

## 📈 Performance Expectations

| Task | Time |
|------|------|
| Backend startup | < 2 seconds |
| Frontend startup | < 1 second |
| Transaction processing | < 500ms |
| Test suite | < 2 minutes |
| Test report generation | < 3 minutes |

---

## 🔐 Security Notes

- ✅ **Test Cards Only** - No real card data
- ✅ **Luhn Validation** - Card number checksums validated
- ✅ **No Card Storage** - Cards not persisted in database
- ✅ **CORS Enabled** - Frontend can communicate with backend
- ✅ **In-Memory DB** - Data reset on restart

---

## ✨ Success Indicators

### ✓ Everything is working if you see:

1. **Backend Terminal**
   ```
   ✅ Connected to in-memory SQLite database
   ✅ Database schema initialized
   🏷️  POS Simulator Backend running on http://localhost:3001
   ```

2. **Frontend Terminal**
   ```
   Serving HTTP on 0.0.0.0 port 3000
   ```

3. **Browser**
   - POS Terminal Simulator UI visible
   - Can enter card details
   - Can process transactions
   - EMV Tags tab has data
   - ISO 8583 tab has data

4. **Tests** (if running)
   ```
   32 passed (45s)
   ✓ All EMV tests passed
   ✓ All ISO 8583 tests passed
   ✓ All API tests passed
   ```

---

**Version:** 1.0.0  
**Last Updated:** 2026-10-11  
**Status:** Ready to Use
