# Terminal coverage gaps test plan

Scope: UI coverage that `tests/ui/agent/terminal-sale.spec.js` does not have and that would be lost
if `tests/ui/payment-form-*.spec.js` are retired. New specs go in `tests/ui/agent/`; all locators in
`tests/ui/pages/TerminalPage.js`.

Already covered, not repeated: Visa 1111 approved 00, Visa 0002 declined 51, Luhn error, EMV/ISO tabs populated.

Source of truth is the live UI at http://localhost:3000 (observed 2026-10-17) plus `frontend/index.html`.
Note: CLAUDE.md still says the submit button is "PROCESS TRANSACTION" and that masks show `•••• NNNN`.
Live UI: button is "CHARGE" (TerminalPage already uses it), and `#summary-card` shows
`<first4> ************` (e.g. "6011 ************"), so the last 4 digits are NOT displayed.

Existing page-object members reusable as-is: `goto()`, `pay({number, exp, cvv, amount})`, `testCardSelect`,
`cardNumber`, `expiry`, `cvv`, `amount`, `submit`, `status`, `authCode`, `resultAmount`, `responseCode`,
`brand`, `declineReason`, `maskedCard`, `error`.

## Scenario: Discover card is approved and identified as Discover
- Priority: P0
- Test card: Discover •••• 1117 (observed)
- Preconditions: terminal loaded, backend online, no prior result.
- Steps:
  1. Open the terminal.
  2. Pay with card 6011...1117 (full PAN typed by test from the CLAUDE.md table), exp 12/25, CVV 123, amount 20.00.
- Expected (observed): status "APPROVED"; response code "00"; brand "DISCOVER"; decline reason "N/A";
  amount "$20.00"; auth code matches `AUTH` + 6 uppercase hex chars (do not assert the exact value).
  Do NOT assert the masked card: the current "6011 ************" is suspected defect 1 (reviewer: intended format is last 4).
- Elements: textbox "Card Number:", "Expiration (MM/YY):", "CVV:", spinbutton "Amount ($):", button "CHARGE";
  `#result-status`, `#summary-response`, `#summary-brand`, `#summary-decline`, `#result-auth-code`, `#result-amount`
  (result ids already in the page object as a known testability gap).
- API cross-check: read `#result-transaction-id` (new member `transactionId`, `#id`, testability gap), then
  `GET /api/transactions/:id` -> status APPROVED, response_code "00", card_brand "DISCOVER", amount 20.

## Scenario: Mastercard •••• 4444 and Amex •••• 0005 are approved with the right brand
- Priority: P1
- Test cards: Mastercard •••• 4444, Amex •••• 0005. Not covered anywhere in current UI tests (old specs only use Visa/Discover).
- Preconditions: as above. Parameterize as one test per card (data-driven titles with last 4 only).
- Steps: pay with each card, exp 12/25, CVV 123, amount 15.00.
- Expected (from backend code and CLAUDE.md table; MC/Amex not run live, TO CONFIRM at generation): APPROVED, "00",
  brand "MASTERCARD" / "AMEX", decline reason "N/A", amount "$15.00".
  Amex is a 15-digit PAN; confirm CVV 123 is accepted (the UI pattern allows 3-4 digits).
- Elements: same as above.
- API cross-check: `GET /api/transactions/:id` card_brand matches.

## Scenario: Lost Card •••• 9987 is declined with 41
- Priority: P0 (regression for fixed defect 2: this PAN once failed Luhn and returned 400)
- Test card: Visa •••• 9987 (observed)
- Steps: pay with 4000...9987, exp 12/25, CVV 123, amount 20.00.
- Expected (observed): status "DECLINED"; response code "41"; decline reason "Lost Card"; brand "VISA";
  auth code "N/A"; amount "$20.00"; `#error-message` hidden (no Luhn error, i.e. not the old 400 behaviour).
- Elements: as above, plus `error` (`#error-message`).
- API cross-check: `GET /api/transactions/:id` -> status DECLINED, response_code "41", auth_code null.

## Scenario: Selecting a test card from the dropdown fills the card number
- Priority: P2
- Test card: any, e.g. Discover •••• 1117
- Preconditions: terminal loaded.
- Steps: choose the "6011 1111 1111 1117 (Approved)" option in the "Test Cards:" combobox.
- Expected (observed): "Card Number:" value becomes the unspaced PAN (digits only). Optional follow-on: fill the other
  fields and the sale approves as DISCOVER. Not in the original old specs but cheap and uses a real feature; drop if the reviewer wants strict parity.
- Elements: combobox "Test Cards:" (`testCardSelect`, exists); new page-object method `selectTestCard(optionValue)`
  using `selectOption`. Option values are the raw PANs, option labels contain spaced PANs; label-based selection would put
  a full PAN in test code either way, so keep PANs only in a test-data constant and title with last 4.

## Scenario: Submitting an empty form is blocked by the browser, not the app
- Priority: P0
- Preconditions: freshly loaded form, all fields empty, no transaction made.
- Steps: 1. Click "CHARGE" with every field empty.
- Expected (observed live): no request is made and no result appears; `#result-status` remains hidden; `#error-message`
  remains hidden; focus moves to the first invalid field, "Card Number:" (snapshot showed it `[active]`).
  The old spec expected the text "Missing required fields" - that string only comes from the API (400) and is NOT
  reachable through the UI because the form inputs are `required`. Do not assert it here.
- Assertions: `error` hidden, `status` hidden, `cardNumber` focused. Optionally assert the native message via the DOM
  `validity.valueMissing` / `validationMessage` (needs `evaluate` inside a page-object method; exact message text is browser/locale
  dependent, so assert `valueMissing` true, not the string).
- Also assert no network call: page object method `expectNoProcessRequest` using `page.waitForRequest` negative or a
  `page.route` counter (TO DECIDE with reviewer).
- Elements: button "CHARGE", textbox "Card Number:".
- Variants (each one test row, same expected pattern, focus lands on the named field):
  - only card filled -> focus "Expiration (MM/YY):"
  - exp format wrong, e.g. "1225" -> native `pattern` mismatch, blocked, focus "Expiration (MM/YY):"
  - CVV "12" -> pattern `\d{3,4}` mismatch, blocked
  - Test card must be valid for variants (use Visa •••• 1111) so the blocker is the field under test.

## Scenario: Zero and negative amounts are blocked by the browser
- Priority: P1
- Test card: Discover •••• 1117 (zero observed live); Visa •••• 1111 for negative.
- Steps: fill card, exp 12/25, CVV 123; amount "0" (then "-5", then "0.001"); click "CHARGE".
- Expected (observed for 0): submission blocked, no result, `#error-message` hidden, focus on "Amount ($):". "-5" blocked by `min=0.01`
  (not run live). "0.001" blocked by `step=0.01` (not run live; TO CONFIRM).
  The API would answer 400 "Missing required fields" for amount 0 but the UI cannot reach it.
- Elements: spinbutton "Amount ($):", button "CHARGE".

## Scenario: Backend unreachable shows a backend error
- Priority: P1
- Test card: Visa •••• 1111 (never reaches the server).
- Approach (do NOT stop the real backend): in a page-object method `failBackend()` call
  `page.route('http://localhost:3001/api/**', r => r.abort())` before `goto()`. Only the `**` pattern under the API origin may be touched.
  Route must be set before `goto` so the health poll also fails.
- Steps: 1. `failBackend()` then `goto()`. 2. Pay with 4111...1111, 12/25, 123, 12.34.
- Expected:
  - `#error-message` visible and starts with "❌ Backend error: " (from `showError('Backend error: ' + error.message)`).
    The suffix is the browser's fetch failure message; in Chromium this is expected to be "Failed to fetch" but it is
    TO CONFIRM (not observed, I did not abort the API). Assert `toContainText('Backend error')` until confirmed.
  - no result shown (`status` hidden).
  - Header badge reads "✗ Backend: Offline" (set by the health poll on load and every 5 s) - TO CONFIRM; badge has no role
    or testid, only `#backend-status` (testability finding).
- Elements: `error` (`#error-message`), new `backendStatus` (`#backend-status`, text-only div, testability gap).
- Companion check (P2): with the API aborted, "Load History" shows "Failed to load history: ..." (`showError`). TO CONFIRM text.
  Button "📋 Load History".
- API cross-check: not applicable (no transaction). After the test, an unrouted `GET /api/health` should still be 200.

## Scenario: Terminal is usable and a sale completes at phone viewport
- Priority: P1
- Test card: Visa •••• 1111
- Preconditions: `test.use({ viewport: { width: 375, height: 812 } })` (matches the old spec; no device emulation).
- Steps: 1. Open the terminal. 2. Check the form fields and "CHARGE" are visible. 3. Pay 9.99 with 4111...1111. 4. Check result.
- Expected: CSS puts the layout in one column at <=1024px (results panel below the form); every form field and the
  "CHARGE" button visible after `scrollIntoViewIfNeeded` (Playwright auto-scrolls on click); status "APPROVED", response "00",
  brand "VISA", amount "$9.99"; no horizontal page overflow (optional: `scrollWidth <= innerWidth`, TO CONFIRM it holds - not observed;
  the results table and monospace values use `word-break: break-all`).
  The result panel is below the fold, so assert with `toBeVisible()` then the text, not a viewport-bound check.
- Elements: all existing members. Heading "💳 Payment Form" (`getByRole('heading', { name: 'Payment Form' })`) for the load check; add `paymentFormHeading`.
  Note I could not resize the browser in the planning session, so mobile behaviour is from CSS/HTML only; verify at generation.
- API cross-check: transaction id from `#result-transaction-id` -> `GET /api/transactions/:id` approved, amount 9.99.

## Scenario: Visual snapshot of the empty form
- Priority: P2 (keep, but see recommendation)
- Preconditions: fresh load, nothing typed. Single fixed viewport (e.g. 1280x720), one browser project.
- Steps: 1. Open the terminal. 2. `expect(page).toHaveScreenshot('terminal-empty.png')` with animations disabled.
- Expected: matches baseline. Dynamic content to handle: the header badge "Backend: Online" (flips to "Checking..." before the first
  health poll resolves, so wait for it to read "Backend: Online" before shooting or mask it); gradient background and system
  font stack mean baselines are OS/browser specific, so baselines must be generated on the same platform as CI.
- Elements: `backendStatus` (`#backend-status`) for mask/wait; no other locator.
- Recommendation: low-value, high-flake. Keep only if the team pins one OS/browser for snapshots.

## Scenario: Visual snapshot of an approved result — DROPPED by reviewer (2026-10-17), do not generate
- Priority: P2 (recommend DROP unless masking is accepted)
- Test card: Visa •••• 1111, amount 12.34
- Steps: pay, wait for status "APPROVED", screenshot with masks.
- Dynamic values that must be masked: Transaction ID (`#result-transaction-id`, UUID), Auth Code (`#result-auth-code`, derived from the UUID),
  Timestamp (`#result-timestamp`, locale/time), header badge. Summary tab has no dynamic values besides masked card (stable "4111 ************").
  EMV Tags / ISO 8583 tabs contain simulated random values (and ISO field values that likely include time/STAN): do NOT snapshot those tabs.
- Expected: approved pill, "$12.34", response "00", brand "VISA", all masked regions equal.
- Elements: new `transactionId` (`#result-transaction-id`), `timestamp` (`#result-timestamp`), existing `authCode`, `backendStatus`; a
  page-object getter `dynamicRegions()` returns these for the `mask` option so specs hold no raw locators.
- Recommendation: the functional scenarios above already assert amount, status, code and brand as text, which is a better oracle than pixels.
  Masking 4 regions leaves little unmasked signal. Prefer a locator-scoped snapshot (`toHaveScreenshot` on the `#result-section` with masks)
  over a full page, or drop this one.

## Testability findings
- No `data-testid`, no roles/ARIA on result fields, error banner or badge: result and error access relies on `#id` (already so in TerminalPage, documented there).
- New ids needed on top of the current page object: `#result-transaction-id`, `#result-timestamp`, `#backend-status`, `#result-section` (visible/hidden check).
- `#error-message` has no `role="alert"`, so assistive tech and `getByRole('alert')` cannot find it.
- Validation messages are native browser bubbles: not in the DOM, not screenshot-able; only `validity` / focus can be asserted.
- No way to read the last 4 digits of the PAN in the result (see defect 1), which blocks asserting "masked to last 4" in the UI.

## Suspected defects
1. Observed: `#summary-card` shows "6011 ************" (Discover) and "4000 ************" (Lost Card): the first 4 digits are displayed and the last 4 are hidden.
   Expected (per CLAUDE.md "mask in output •••• 1111", and typical PCI display): last 4 visible, the rest masked. Source: `maskCardNumber` in `backend/server.js`
   (`slice(0,4) + ' ' + rest as '*'`). The stored `card_number_masked` has the same value. No scenario asserts the mask; one will need a human decision on the intended format.
2. Server `!amount` check treats amount 0 as missing and returns "Missing required fields" - harmless through the UI (native `min`), only reachable via direct API.
3. Server validates Luhn but not expiry in the past, CVV length or amount upper bound; the UI does not either. Out of scope; noted only.

## Reviewer decisions (2026-10-17)
- Mask format: intended display is LAST 4 (`•••• NNNN`). Current first-4 output is a confirmed defect in `backend/server.js`
  (`maskCardNumber`), to be fixed by a human. No generated test asserts the mask until the backend is fixed.
- Backend-down: assert only `toContainText('Backend error')`. Do not hard-code "Failed to fetch". Offline badge assertion only if observed at generation.
- Visual snapshots: KEEP the empty-form snapshot; DROP the approved-result snapshot.
- Dropdown scenario: INCLUDE.
- Native validation (default, not objected to): assert via hidden result/error, focus, and `validity` flags — not browser message text.
  The "no request sent" network assertion is optional; skip it unless it's trivial in the page object.

## Scenario index
| Scenario | Priority |
|---|---|
| Discover card is approved and identified as Discover | P0 |
| Mastercard •••• 4444 and Amex •••• 0005 are approved with the right brand | P1 |
| Lost Card •••• 9987 is declined with 41 | P0 |
| Selecting a test card from the dropdown fills the card number | P2 |
| Submitting an empty form is blocked by the browser, not the app | P0 |
| Zero and negative amounts are blocked by the browser | P1 |
| Backend unreachable shows a backend error | P1 |
| Terminal is usable and a sale completes at phone viewport | P1 |
| Visual snapshot of the empty form | P2 |
| ~~Visual snapshot of an approved result~~ | DROPPED |
