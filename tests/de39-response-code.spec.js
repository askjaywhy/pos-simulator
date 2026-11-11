import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// DEF-002 regression: DE39 and EMV tag 8A carry the authorization decision, not a hard-coded 00.
// Tag 8A is an2, so the code is stored as ASCII hex ('51' -> 3531).
const API = 'http://localhost:3001/api';
const CASES = [
  { pan: '4111111111111111', last4: '1111', code: '00', tag8a: '3030' },
  { pan: '4000000000000002', last4: '0002', code: '51', tag8a: '3531' },
  { pan: '4000000000009987', last4: '9987', code: '41', tag8a: '3431' },
  { pan: '5105105105105100', last4: '5100', code: '05', tag8a: '3035' },
];

test.describe('DE39 and tag 8A (DEF-002)', () => {
  for (const c of CASES) {
    test(`•••• ${c.last4} carries response code ${c.code} in DE39 and 8A`, async ({ request }) => {
      const res = await request.post(`${API}/transactions/process`, {
        data: { card_number: c.pan, exp_date: TEST_EXP, cvv: '123', amount: 20.0 },
      });
      expect(res.ok()).toBeTruthy();
      const tx = await res.json();

      expect(tx.response_code).toBe(c.code);
      expect(tx.iso8583.fields['39'].value).toBe(c.code);
      expect(tx.emv.tags['8A'].value).toBe(c.tag8a);
      expect(tx.emv.tlv_hex).toContain(`8A02${c.tag8a}`);

      const stored = await (await request.get(`${API}/transactions/${tx.transaction_id}`)).json();
      expect(stored.iso8583_message.fields['39'].value).toBe(c.code);
    });
  }
});
