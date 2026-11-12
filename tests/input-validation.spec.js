import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// DEF-004 / DEF-006 regression: the API rejects bad expiry months and bad amounts with HTTP 400.
// The UI blocks most of these in the browser; these tests hit the API directly.
const API = 'http://localhost:3001/api';
const PAN = '4111111111111111';

async function pay(request, overrides) {
  return request.post(`${API}/transactions/process`, {
    data: { card_number: PAN, exp_date: TEST_EXP, cvv: '123', amount: 10.0, ...overrides },
  });
}

test.describe('Amount validation (DEF-006)', () => {
  for (const amount of [-5, -0.01, 0.001, 19.999, 1e13, 'abc', '1.005']) {
    test(`amount ${JSON.stringify(amount)} is rejected with 400`, async ({ request }) => {
      const res = await pay(request, { amount });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(/^Invalid amount/);
    });
  }

  test('missing amount still returns "Missing required fields"', async ({ request }) => {
    const res = await pay(request, { amount: undefined });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('Missing required fields');
  });

  for (const [amount, de4] of [[0.01, '000000000001'], [9999999999.99, '999999999999'], ['12.50', '000000001250']]) {
    test(`amount ${JSON.stringify(amount)} is accepted and encoded as ${de4}`, async ({ request }) => {
      const res = await pay(request, { amount });
      expect(res.status()).toBe(200);
      expect((await res.json()).iso8583.fields['4'].value).toBe(de4);
    });
  }
});

test.describe('Expiry month validation (DEF-004)', () => {
  for (const exp of ['00/28', '13/28', '99/28']) {
    test(`expiry ${exp} is rejected with 400`, async ({ request }) => {
      const res = await pay(request, { exp_date: exp });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toBe('Invalid expiration month (01-12)');
    });
  }

  for (const exp of ['01/28', '12/28']) {
    test(`expiry ${exp} is accepted`, async ({ request }) => {
      const res = await pay(request, { exp_date: exp });
      expect(res.status()).toBe(200);
      expect((await res.json()).status).toBe('APPROVED');
    });
  }
});
