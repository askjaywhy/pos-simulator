# POS Simulator — agent rules

Three sub-agents (**test-planner → test-generator → test-healer**) build and maintain a
page-object UI test layer for this simulator. These rules bind all of them.

## System under test
- Terminal UI (single page, `frontend/index.html`): http://localhost:3000
- Express API (`backend/server.js`, in-memory SQLite, EMV + ISO 8583 in
  `backend/emv-iso8583.js`): http://localhost:3001/api
- Start with `START_POS_SIMULATOR.bat` / `.ps1`. Data resets on restart; `POST /api/admin/reset`
  also clears it.
- Playwright MCP is restricted to those two origins in `.mcp.json`.
- **EMV tag values are simulated, not real cryptograms.** Tests verify transaction flow and
  response handling, not cryptographic validity. Assert on tag presence/format, never on
  cryptogram values.

## Test cards (from `backend/server.js` TEST_CARDS and the UI dropdown)
| Card (mask in output) | Brand | Expected |
|---|---|---|
| •••• 1111 | Visa | APPROVED, 00 |
| •••• 4444 | Mastercard | APPROVED, 00 |
| •••• 0005 | Amex | APPROVED, 00 |
| •••• 1117 | Discover | APPROVED, 00 |
| •••• 0002 | Visa | DECLINED, 51 Insufficient Funds |
| •••• 9987 | Visa | DECLINED, 41 Lost Card |

Never invent card numbers. Never print a full PAN in logs, plans or test names — mask to last 4.

## Terminal UI facts (verified from index.html)
- Inputs have `<label for>`: "Card Number:", "Expiration (MM/YY):", "CVV:", "Amount ($):".
  Use `getByLabel`. They have `id`s, **not** `name` attributes.
- Submit button text is "PROCESS TRANSACTION" (not "Pay").
- Results: status in `#result-status`; response code in `#summary-response`; brand in
  `#summary-brand`; decline reason in `#summary-decline`; errors in `#error-message`.
- Tabs: "Summary", "EMV Tags", "ISO 8583".
- The UI has no `data-testid`s. If a stable locator needs one, report it as a testability
  finding; do not edit the UI.

## What agents may change
- Writable: `tests/` and `specs/` only. Enforced by `.claude/hooks/guard.js`.
- **Never** edit `backend/`, `frontend/`, or the EMV / ISO 8583 classes to make a test pass.
- The existing API specs in `tests/*.spec.js` and UI specs in `tests/ui/payment-form-*.spec.js`
  are the baseline. Don't rewrite them. New page-object specs go in `tests/ui/agent/`;
  a human decides when to retire the old ones.

## Layout for the new UI layer
- `specs/*.plan.md`          — planner output, human-reviewed before generation
- `tests/ui/pages/*.js`      — page objects. **All new UI locators live here only.**
- `tests/ui/fixtures.js`     — injects page objects into tests
- `tests/ui/agent/*.spec.js` — new UI tests; page-object methods only, no raw locators
- `heal-log/heals.jsonl`     — automatic audit log of every page-object edit

## Locator policy (priority order)
`getByRole` → `getByLabel` → `getByTestId` → `#id` with a comment why. Never XPath, never
`text=` for interactive elements, never nth-child.

## Assertion policy — non-negotiable
- Assertions express payment outcomes: APPROVED/DECLINED, response code, amount, brand,
  decline reason, Luhn / validation errors. They are the spec.
- No agent may edit, weaken, or delete an existing `expect(...)`. No skip/fixme, retries, or
  timeout inflation. Enforced by hook.
- A wrong response code, amount or status is a **possible defect**: stop and report observed
  vs expected.
- Where useful, confirm a UI result through the API (the transaction from
  `GET /api/transactions/:id` matches what the terminal displayed).

## Fixed defects (regression-test these)
1. `GET /api/transactions/history` was registered after `GET /api/transactions/:id`, so Express
   matched "history" as an id (404). Fixed 2026-10-16 by moving the route above `/:id`.
2. The Lost Card test PAN (old `•••• 0009`) failed Luhn, so it returned 400 instead of a 41 decline.
   Fixed 2026-10-16: replaced with `•••• 9987` (Luhn-valid, Stripe lost-card test number).

## Commands (run from the `tests` folder — config lives there)
- All: `cd tests && npx playwright test`
- New UI layer: `cd tests && npx playwright test ui/agent --reporter=line`
- Guard self-test (project root): `node --test .claude/hooks/tests/guard.test.js`
- Windows: use `python` or `py`, not `python3`, if any script needs Python.
