# POS Simulator: Defect Log

Found by API testing of the POS simulator (`backend/server.js`, `backend/emv-iso8583.js`). Each defect has an automated test in `src/test/java/lab/api/KnownDefectsTest.java`. The test asserts the **correct** behavior, so it fails until the defect is fixed.

Run them with:
```powershell
docker compose run --rm java-tests mvn -B -ntp test -Dgroups=known-defect -DexcludedGroups=
```

| ID | Title | Severity | Area |
|---|---|---|---|
| DEF-001 | ISO 8583 DE4 amount loses a cent for some values | High | Financial accuracy |
| DEF-002 | DE39 is always `00`, even on declined transactions | High | ISO 8583 / reconciliation |
| DEF-003 | Full PAN returned by the API and stored unmasked | Critical | PCI DSS |
| DEF-004 | Invalid expiry month (13) accepted | Medium | Input validation |
| DEF-005 | Expired card approved | High | Authorization rules |
| DEF-006 | Negative amount approved | High | Input validation |
| DEF-007 | Declined transaction can be refunded | High | Refunds |

---

### DEF-001 ISO 8583 DE4 amount loses a cent for some values
**Severity:** High. Settlement and reconciliation amounts won't match the authorized amount.
**Steps:** `POST /api/transactions/process` with Visa 4111…1111, `amount: 19.99`.
**Expected:** `iso8583.fields.4.value` = `000000001999`
**Actual:** `000000001998`. The same happens for 0.29, 4.35 and 1.15.
**Root cause:** `emv-iso8583.js` uses `Math.floor(this.amount * 100)`. In binary floating point, `19.99 * 100` = `1998.9999999999998`, and `floor` drops a cent.
**Fix:** use `Math.round(amount * 100)`, or better, carry amounts as integer minor units (cents) end to end.

### DEF-002 DE39 is always `00`, even on declined transactions
**Severity:** High. The ISO message says "approved" while the API says "declined", so downstream systems that read DE39 will treat declines as approvals.
**Steps:** process card 4000…0002 (insufficient funds).
**Expected:** `response_code` = `51` and `iso8583.fields.39.value` = `51`
**Actual:** `response_code` = `51`, but DE39 = `00`.
**Root cause:** `buildTransaction()` hard-codes `setField('39', '00')`. The decline decision in `server.js` is made later and never written back to the message.
**Fix:** set DE39 from the authorization decision before building the message.

### DEF-003 Full PAN returned by the API and stored unmasked
**Severity:** Critical (PCI DSS Requirement 3: protect stored account data; mask PAN when displayed).
**Steps:** process any card. Inspect the response, then `GET /api/transactions/{id}`.
**Expected:** DE2 masked or truncated (for example `411111******1111`) and the PAN absent from `hex_message`. Only the masked or tokenized PAN stored.
**Actual:** DE2 contains the full 16-digit PAN in the response, in `hex_message`, and in the `iso8583_message` column in SQLite, even though `card_number_masked` is stored separately.
**Fix:** mask DE2 in API responses and storage. Never persist the full PAN; use tokenization if it must be recoverable.

### DEF-004 Invalid expiry month accepted
**Severity:** Medium
**Steps:** process Visa with `exp_date: "13/30"`.
**Expected:** HTTP 400, invalid expiration date.
**Actual:** HTTP 200, approved. Validation only checks the `NN/NN` format.
**Fix:** validate month 01–12.

### DEF-005 Expired card approved
**Severity:** High
**Steps:** process Visa with `exp_date: "01/20"`.
**Expected:** declined, DE39 `54` (Expired Card).
**Actual:** approved `00`. The published test cards themselves use `12/25`, which is already in the past.
**Fix:** compare the expiry against the current month and decline with `54`.

### DEF-006 Negative amount approved
**Severity:** High
**Steps:** process Visa with `amount: -5.00`.
**Expected:** HTTP 400.
**Actual:** HTTP 200, approved. The check is `if (!amount)`, which only catches 0 or missing.
**Fix:** require a positive number with at most 2 decimal places.

### DEF-007 Declined transaction can be refunded
**Severity:** High. You can't refund money that was never captured.
**Steps:** process card 4000…9987 (declined 41), then `POST /api/transactions/{id}/refund`.
**Expected:** HTTP 409 or 422.
**Actual:** HTTP 200, `status: REFUNDED`. The endpoint also never records the refund, so the same transaction can be refunded any number of times.
**Fix:** allow refunds only for APPROVED transactions, persist refunds, and cap the total refunded at the original amount.
