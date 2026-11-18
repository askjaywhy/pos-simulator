# Setup Guide: POS Simulator (EMV / ISO 8583)

Updated 2026-11-17. Windows is the primary platform; Linux works for the backend, UI and API tests (that's what CI runs).

## Prerequisites
- Node.js 18 or newer (`node --version`). CI uses Node 22.
- Ports 3000 (UI) and 3001 (API) free.
- No Python needed. The UI is served by `scripts/serve-ui.js`.
- For the QA lab only: Docker Desktop with about 6 GB RAM free (see `lab/README.md`).

## 1. Start everything (Windows)
```powershell
cd C:\Users\Askja\pos-simulator
.\START_POS_SIMULATOR.bat          # backend, UI and tests windows
.\START_POS_SIMULATOR.bat test     # same, then runs the ready suite
```
The launcher checks Node and the two ports, then opens three windows:

| Window | Script | What it does |
|---|---|---|
| Backend :3001 | `scripts/run-backend.ps1` | `npm install` on first run, then `npm start` |
| UI :3000 | `scripts/run-ui.ps1` | `node serve-ui.js` |
| Tests | `scripts/run-tests.ps1` | installs test deps and Chromium, waits for both servers, runs the 25 guard self-tests, prints commands |

If scripts are blocked, double-click the `.bat`. If a port is busy, close the windows from the last run.

## 2. Start manually (any OS)
```bash
cd backend && npm install && npm start      # terminal 1: http://localhost:3001
node scripts/serve-ui.js                    # terminal 2: http://localhost:3000
```

## 3. Check it's up
```bash
curl http://localhost:3001/api/health       # {"status":"healthy",...}
curl http://localhost:3001/api/test-cards
```
Open http://localhost:3000. The header badge should read **✓ Backend: Online**.

## 4. First transaction
| Field | Value |
|---|---|
| Card Number | `4111111111111111` (or pick from **Test Cards**) |
| Expiration | `12/28` |
| CVV | `123` |
| Amount | `99.99` |

Click **PROCESS TRANSACTION**. Expect APPROVED, response code `00`, brand VISA, card `•••• 1111`. The **EMV Tags** tab shows DE55; the **ISO 8583** tab shows the 0100 with DE2 truncated to `411111******1111`.

## 5. Test cards
| Card | Brand | Result |
|---|---|---|
| 4111 1111 1111 1111 | Visa | 00 |
| 5555 5555 5555 4444 | Mastercard | 00 |
| 3782 822463 10005 | Amex | 00 |
| 6011 1111 1111 1117 | Discover | 00 |
| 4000 0000 0000 0002 | Visa | 51 Insufficient Funds |
| 4000 0000 0000 9987 | Visa | 41 Lost Card |
| 4000 0000 0000 0010 | Visa | 54 (API only, not in the dropdown) |
| 5105 1051 0510 5100 | Mastercard | 05 (API only) |

All use expiry `12/28`, CVV `123`. Any card with a past expiry declines `54`.

## 6. Scenarios to try through the API
```bash
API=http://localhost:3001/api

# Approval with EUR: DE49 978, tag 5F2A 0978
curl -s -X POST $API/transactions/process -H "Content-Type: application/json" \
  -d '{"card_number":"4111111111111111","exp_date":"12/28","cvv":"123","amount":19.99,"currency":"EUR"}'

# Expired card: 54 in response_code, DE39 and tag 8A (3534)
curl -s -X POST $API/transactions/process -H "Content-Type: application/json" \
  -d '{"card_number":"4111111111111111","exp_date":"01/20","cvv":"123","amount":10}'

# Partial refund (0200), then the rest
curl -s -X POST $API/transactions/<id>/refund -H "Content-Type: application/json" -d '{"amount":5.00}'
curl -s -X POST $API/transactions/<id>/refund
curl -s $API/transactions/<id>/refunds

# Reversal (0400) of an approved, unrefunded transaction
curl -s -X POST $API/transactions/<id>/reversal

# The 0100 and 0110 for a transaction
curl -s $API/transactions/<id>/iso8583
```

Expected errors: 400 for bad input (Luhn, expiry format or month, amount, currency); 404 for an unknown id; 422 to refund or reverse a non-APPROVED transaction; 409 to over-refund or to reverse after a refund.

## 7. Pinning the date (`SIM_NOW`)
```powershell
$env:SIM_NOW = '2028-12-31T23:59:59Z'; cd backend; node server.js   # logs "SIM_NOW set: ..."
Remove-Item Env:SIM_NOW
```
Expiry is checked against the UTC month. Leave `SIM_NOW` unset when running the test suites; `expiry-date.spec.js` builds its dates from the real clock.

## 8. Run the tests
Always run Playwright from `tests/`. From the repo root, `npx` fetches a second Playwright and fails with "did not expect test.describe()".
```bash
cd tests
npm install
npx playwright install chromium
npm run test:ready        # API + page-object UI suite (both servers up)
npm run test:agent-ui     # UI page-object specs only
npm run test:guard        # 25 hook self-tests
npm test                  # everything
npm run report            # last HTML report
```
The visual baseline (`terminal-empty-chromium-win32.png`) is Windows-only. CI runs with `--ignore-snapshots`.

Java suite and lab: see `lab/README.md` and `lab/java-tests/README.md`.

## 9. Troubleshooting
| Problem | Fix |
|---|---|
| Launcher says a port is in use | Close the old windows, or `netstat -ano \| findstr :3001` then `taskkill /PID <pid> /F` |
| Badge shows Backend: Offline | Check the backend window; `curl http://localhost:3001/api/health` |
| Browser downloads index.html instead of showing it | You're on `python -m http.server`; use `node scripts/serve-ui.js` |
| Test cards suddenly decline 54 | The date is past Dec 2028, or `SIM_NOW` is set |
| A `scripts\*.ps1` is missing | Defender may have quarantined it; restore it |
| Data disappeared | The database is in memory; a backend restart clears it |
| Guard hooks don't fire in Claude Code | Start a fresh `claude` session from the repo root and check `/hooks` |

## Security notes
- Test cards only. Never enter a real card.
- DE2 is truncated (first 6 / last 4) in responses, `hex_message` and storage. `card_masked` shows the last 4.
- CVV is required by the API but is not stored.
- Not EMV- or network-certified: cryptograms are fixed samples.
