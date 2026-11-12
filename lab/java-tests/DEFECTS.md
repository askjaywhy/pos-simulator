# POS Simulator: Defect Log

Found by API testing of the POS simulator (`backend/server.js`, `backend/emv-iso8583.js`). Each defect has an automated test in `src/test/java/lab/api/KnownDefectsTest.java`. The test asserts the **correct** behavior, so it fails until the defect is fixed.

Run them with:
```powershell
docker compose run --rm java-tests mvn -B -ntp test -Dgroups=known-defect -DexcludedGroups=
```

| ID | Title | Severity | Area |
|---|---|---|---|
| DEF-001 | ISO 8583 DE4 amount loses a cent for some values (**fixed**) | High | Financial accuracy |
| DEF-002 | DE39 is always `00`, even on declined transactions (**fixed**) | High | ISO 8583 / reconciliation |
| DEF-003 | Full PAN returned by the API and stored unmasked (**fixed**) | Critical | PCI DSS |
| DEF-004 | Invalid expiry month (13) accepted (**fixed**) | Medium | Input validation |
| DEF-005 | Expired card approved (**fixed**) | High | Authorization rules |
| DEF-006 | Negative amount approved (**fixed**) | High | Input validation |
| DEF-007 | Declined transaction can be refunded | High | Refunds |
| DEF-008 | ISO 8583 primary bitmap wrong for data elements 9 and up (**fixed**) | High | ISO 8583 |

---

### DEF-001 ISO 8583 DE4 amount loses a cent for some values
**Severity:** High. Settlement and reconciliation amounts won't match the authorized amount.
**Steps:** `POST /api/transactions/process` with Visa 4111…1111, `amount: 19.99`.
**Expected:** `iso8583.fields.4.value` = `000000001999`
**Actual:** `000000001998`. The same happens for 0.29, 4.35 and 1.15.
**Root cause:** `emv-iso8583.js` uses `Math.floor(this.amount * 100)`. In binary floating point, `19.99 * 100` = `1998.9999999999998`, and `floor` drops a cent.
**Fix:** use `Math.round(amount * 100)`, or better, carry amounts as integer minor units (cents) end to end.
**Status:** Fixed. `buildTransaction()` now uses `Math.round(Number(amount) * 100)`. That is exact for any amount with at most 2 decimals; amounts with more decimals are DEF-006's job to reject. Regression tests: `SimulatorApiTest.de4AmountPrecision` (19.99, 0.29, 4.35, 1.15, 0.01, 1234.56) and `tests/de4-amount.spec.js`.

### DEF-002 DE39 is always `00`, even on declined transactions
**Severity:** High. The ISO message says "approved" while the API says "declined", so downstream systems that read DE39 will treat declines as approvals.
**Steps:** process card 4000…0002 (insufficient funds).
**Expected:** `response_code` = `51` and `iso8583.fields.39.value` = `51`
**Actual:** `response_code` = `51`, but DE39 = `00`.
**Root cause:** `buildTransaction()` hard-codes `setField('39', '00')`. The decline decision in `server.js` is made later and never written back to the message.
**Fix:** set DE39 from the authorization decision before building the message.
**Status:** Fixed. `server.js` calls `EMVTransaction.setAuthorizationResult(responseCode)` after the decision; it sets DE39 and EMV tag `8A` (ASCII hex, e.g. `51` → `3531`) and rebuilds DE55. Regression tests: `SimulatorApiTest.de39MatchesDecision` (00/51/41/05) and `tests/de39-response-code.spec.js`. Interim: in a real flow DE39 and `8A` belong in the 0110 response; the simulator still builds only a 0100.

### DEF-003 Full PAN returned by the API and stored unmasked
**Severity:** Critical (PCI DSS Requirement 3: protect stored account data; mask PAN when displayed).
**Steps:** process any card. Inspect the response, then `GET /api/transactions/{id}`.
**Expected:** DE2 masked or truncated (for example `411111******1111`) and the PAN absent from `hex_message`. Only the masked or tokenized PAN stored.
**Actual:** DE2 contains the full 16-digit PAN in the response, in `hex_message`, and in the `iso8583_message` column in SQLite, even though `card_number_masked` is stored separately.
**Fix:** mask DE2 in API responses and storage. Never persist the full PAN; use tokenization if it must be recoverable.
**Status:** Fixed. `getISO8583Data()` now truncates DE2 to first 6 / last 4 (`411111******1111`) and builds `hex_message` from the truncated value; the response, SQLite and the history endpoints all use that output. Regression tests: `SimulatorApiTest.panIsMasked` and `tests/pan-masking.spec.js`. The old known-defect check on `hex_message` could never fail (the hex encodes ASCII, so the PAN appears as `3431…`, not `4111…`); the regression test checks the hex form.

### DEF-004 Invalid expiry month accepted
**Severity:** Medium
**Steps:** process Visa with `exp_date: "13/30"`.
**Expected:** HTTP 400, invalid expiration date.
**Actual:** HTTP 200, approved. Validation only checks the `NN/NN` format.
**Fix:** validate month 01–12.
**Status:** Fixed. After the `NN/NN` format check, a month outside 01–12 returns HTTP 400 `Invalid expiration month (01-12)`. Regression tests: `SimulatorApiTest.invalidExpiryMonthRejected` (00, 13, 99), `validExpiryMonthAccepted` (01, 12) and `tests/input-validation.spec.js`.

### DEF-005 Expired card approved
**Severity:** High
**Steps:** process Visa with `exp_date: "01/20"`.
**Expected:** declined, DE39 `54` (Expired Card).
**Actual:** approved `00`. The published test cards themselves used `12/25`, which was already in the past (moved to `12/28` in `d26677b`).
**Fix:** compare the expiry against the current month and decline with `54`.
**Status:** Fixed. A card is valid through the last day of its expiry month (UTC). After the exact-PAN decline rules, `isCardExpired()` declines it `54` `Expired Card` (DE39 and tag `8A` too). "Now" comes from `simNow()`: the real clock, or the `SIM_NOW` environment variable when set (e.g. `SIM_NOW=2028-12-31T23:59:59Z`), so tests can pin the date and the `12/28` test cards don't silently expire. Regression tests: `SimulatorApiTest.expiredCardDeclined`, `expiredLastMonthDeclined`, `expiringThisMonthApproved`, `declineRuleBeatsExpiry`, and `tests/expiry-date.spec.js` (including boundary unit tests of `isCardExpired`).

### DEF-006 Negative amount approved
**Severity:** High
**Steps:** process Visa with `amount: -5.00`.
**Expected:** HTTP 400.
**Actual:** HTTP 200, approved. The check is `if (!amount)`, which only catches 0 or missing.
**Fix:** require a positive number with at most 2 decimal places.
**Status:** Fixed. The amount must match `^\d+(\.\d{1,2})?$` as text, be greater than 0, and fit DE4 (at most 999,999,999,999 minor units); otherwise HTTP 400 `Invalid amount: ...`. A missing or `0` amount still returns `Missing required fields`. This also closes DEF-001's 3-decimal edge case (`1.005` is now rejected). Regression tests: `SimulatorApiTest.invalidAmountRejected` (-5, -0.01, 0.001, 19.999, 1e13), `nonNumericAmountRejected`, `boundaryAmountAccepted` (0.01, 9999999999.99) and `tests/input-validation.spec.js`.

### DEF-007 Declined transaction can be refunded
**Severity:** High. You can't refund money that was never captured.
**Steps:** process card 4000…9987 (declined 41), then `POST /api/transactions/{id}/refund`.
**Expected:** HTTP 409 or 422.
**Actual:** HTTP 200, `status: REFUNDED`. The endpoint also never records the refund, so the same transaction can be refunded any number of times.
**Fix:** allow refunds only for APPROVED transactions, persist refunds, and cap the total refunded at the original amount.

### DEF-008 ISO 8583 primary bitmap wrong for data elements 9 and up
**Severity:** High. A host parsing the bitmap would look for the wrong data elements, so the message can't be decoded.
**Steps:** process Visa 4111…1111. Read characters 5–20 of `iso8583.hex_message` (the bitmap).
**Expected:** `5038000002008200`. The message carries DE2, 4, 11, 12, 13, 39, 49 and 55.
**Actual:** `5380028200000000`.
**Root cause:** `ISO8583Message.setBitmapBit()` computes `byteIndex = floor((n-1)/8)` and uses it as an index into the 16-character hex string, so byte N is read from hex characters N and N+1 instead of 2N and 2N+1. DE2–DE8 come out right by luck; every bit from DE9 up lands in the wrong place.
**Fix:** use `byteIndex * 2` as the character offset, or keep the bitmap as a 64-bit `BigInt` and format it at the end.
**Status:** Fixed. `setBitmapBit()` now reads and writes hex characters `2N` and `2N+1`, and marks DE2–DE64 (DE64 was previously excluded). Regression tests: `SimulatorApiTest.bitmapMatchesFields` (decodes the bitmap and compares it with the fields returned, for an approval and a decline) and `tests/iso8583-bitmap.spec.js`.
