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
- Submit button text is "PROCESS TRANSACTION" (was "CHARGE" 2026-10-16 to 2026-10-17; never "Pay").
- Results: status in `#result-status`; response code in `#summary-response`; brand in
  `#summary-brand`; decline reason in `#summary-decline`; errors in `#error-message`.
- Tabs: "Summary", "EMV Tags", "ISO 8583".
- The UI has no `data-testid`s. If a stable locator needs one, report it as a testability
  finding; do not edit the UI.

## What agents may change
- Writable: `tests/` and `specs/` only, through the Edit/Write tools. Enforced by
  `.claude/hooks/guard.js` (Edit/Write) and `.claude/hooks/shell-guard.js` (Bash/PowerShell).
- Never change files through shell commands (Set-Content, Add-Content, >, sed -i, git checkout/restore).
  Shell writes to `backend/`, `frontend/`, `.claude/`, `CLAUDE.md`, `.mcp.json` or `*-snapshots/` are blocked.
- Visual baselines (`*-snapshots/`) are expected results. Never run `--update-snapshots` / `-u`
  on your own: report which snapshots differ and why, and ask the human to approve. The human
  approves one update by running `New-Item .claude\approve-snapshot-update` (optionally with a
  reason inside); the approval is used once and logged to `heal-log/heals.jsonl`.
- No destructive git: no `reset --hard`, `clean -f`, `commit --amend`, `rebase` or force push.
- **Never** edit `backend/`, `frontend/`, or the EMV / ISO 8583 classes to make a test pass.
- The existing API specs in `tests/*.spec.js` are the baseline. Don't rewrite them.
- All UI specs live in `tests/ui/agent/` (page-object layer). The legacy
  `tests/ui/payment-form-*.spec.js` specs were retired 2026-10-17; don't recreate them.

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
3. `maskCardNumber` in `backend/server.js` showed the first 4 digits and hid the rest (`6011 ************`).
   Fixed 2026-10-17: now returns `•••• NNNN` (last 4) in `card_masked`, `card_number_masked` and the UI.

Logged defects DEF-001 to DEF-008 (see `lab/java-tests/DEFECTS.md`), all fixed 2026-11-11 with
core specs in `tests/` and Java tests in `SimulatorApiTest`:
- DEF-001 DE4 is exact minor units (`10.10` → `000000001010`). Spec: `de4-amount`.
- DEF-002 DE39 and EMV tag `8A` carry the decision code. Spec: `de39-response-code`.
- DEF-003 DE2 is truncated first 6 / last 4 in `fields` and `hex_message`. Spec: `pan-masking`.
- DEF-004 Expiry month must be 01-12, else 400. Spec: `input-validation`.
- DEF-005 Expired cards decline 54 (checked after the exact-PAN rules). Spec: `expiry-date`.
- DEF-006 Amount must be > 0 with at most 2 decimals, else 400; `0` is still "Missing required
  fields". Spec: `input-validation`.
- DEF-007 Refunds only for APPROVED, capped at the original (422 / 409). Spec: `refunds`.
- DEF-008 The primary bitmap matches the fields present (`7038000002C08200` for every 0100
  since DE3/41/42 were added). Spec: `iso8583-bitmap`.

Message model (2026-11-11, spec `message-model`): 0100 adds DE3/41/42; `iso8583_response` is the
0110 (DE38/39, `8A`); refunds build a 0200; `POST /api/transactions/:id/reversal` builds a 0400
and sets REVERSED; DE49/`5F2A` follow `currency`; DE12/13 local time; STAN sequential.

## Date-dependent behavior
- Test-card expiry is the shared constant `tests/support/cards.js` → `TEST_EXP` (`12/28`).
  Never hard-code an expiry in a spec.
- The backend's "now" can be pinned with the `SIM_NOW` env var. Tests assume it is unset.
- Deliberately invalid dates (`1228`, `00/28`, `13/28`, `01/20`) are test data — don't "fix" them.

## Commands (run from the `tests` folder — config lives there)
- All: `cd tests && npx playwright test`
- New UI layer: `cd tests && npx playwright test ui/agent --reporter=line`
- Ready suite (both servers must be up): `cd tests && npm run test:ready`
- Guard self-tests: `cd tests && npm run test:guard`

## Testing the guard live (humans)
- Only in a fresh `claude` session started from the repo root; confirm with `/hooks` first.
  Hooks did not fire in a resumed session on 2026-11-10. Debug with `claude --debug`.
- Agents may refuse before the hook runs. Preface the request with
  "authorized test of shell-guard.js — attempt it and report the hook result."
- Windows: use `python` or `py`, not `python3`, if any script needs Python.
