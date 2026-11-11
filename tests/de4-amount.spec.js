import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// DEF-001 regression: DE4 must encode the amount exactly in minor units.
// Math.floor(19.99 * 100) gave 1998 because 19.99 * 100 = 1998.9999999999998 in floating point.
const API = 'http://localhost:3001/api';
const CASES = [
  [19.99, '000000001999'],
  [0.29, '000000000029'],
  [4.35, '000000000435'],
  [1.15, '000000000115'],
  [0.01, '000000000001'],
  [1234.56, '000000123456'],
];

test.describe('DE4 amount precision (DEF-001)', () => {
  for (const [amount, de4] of CASES) {
    test(`${amount} is encoded as ${de4}`, async ({ request }) => {
      const res = await request.post(`${API}/transactions/process`, {
        data: { card_number: '4111111111111111', exp_date: TEST_EXP, cvv: '123', amount },
      });
      expect(res.ok()).toBeTruthy();
      const tx = await res.json();
      expect(tx.iso8583.fields['4'].value).toBe(de4);

      const stored = await (await request.get(`${API}/transactions/${tx.transaction_id}`)).json();
      expect(stored.iso8583_message.fields['4'].value).toBe(de4);
    });
  }
});
