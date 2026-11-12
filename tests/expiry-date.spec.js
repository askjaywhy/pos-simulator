import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';
import { isCardExpired } from '../backend/emv-iso8583.js';

// DEF-005 regression: a card is valid through the last day of its expiry month (UTC);
// after that the simulator declines it 54. Assumes the backend runs without SIM_NOW.
const API = 'http://localhost:3001/api';

// MM/YY for a month relative to now, in UTC like the simulator
function expiry(monthsFromNow) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1));
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}

async function pay(request, card, exp_date) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: card, exp_date, cvv: '123', amount: 10.0 },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe('isCardExpired boundaries (DEF-005, unit)', () => {
  const cases = [
    ['12/28', '2028-12-31T23:59:59Z', false], // last second of the expiry month
    ['12/28', '2029-01-01T00:00:00Z', true],  // first second after it
    ['02/28', '2028-02-29T12:00:00Z', false], // leap day inside the expiry month
    ['01/20', '2026-11-11T00:00:00Z', true],
    ['11/26', '2026-11-30T23:59:59Z', false],
    ['10/26', '2026-11-01T00:00:00Z', true],
  ];
  for (const [exp, now, expired] of cases) {
    test(`${exp} at ${now} is ${expired ? 'expired' : 'valid'}`, () => {
      expect(isCardExpired(exp, new Date(now))).toBe(expired);
    });
  }
});

test.describe('Expired card decline (DEF-005, API)', () => {
  test('01/20 is declined 54 in the API, DE39 and tag 8A', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', '01/20');
    expect(tx.status).toBe('DECLINED');
    expect(tx.response_code).toBe('54');
    expect(tx.decline_reason).toBe('Expired Card');
    expect(tx.auth_code).toBeNull();
    expect(tx.iso8583.fields['39'].value).toBe('54');
    expect(tx.emv.tags['8A'].value).toBe('3534');
  });

  test('a card that expired last month is declined 54', async ({ request }) => {
    expect((await pay(request, '4111111111111111', expiry(-1))).response_code).toBe('54');
  });

  test('a card expiring this month is approved', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', expiry(0));
    expect(tx.status).toBe('APPROVED');
    expect(tx.response_code).toBe('00');
  });

  test('a decline rule takes precedence over expiry (•••• 0002 with 01/20 is 51)', async ({ request }) => {
    expect((await pay(request, '4000000000000002', '01/20')).response_code).toBe('51');
  });

  test('the shared test-card expiry is still valid', async ({ request }) => {
    expect((await pay(request, '4111111111111111', TEST_EXP)).response_code).toBe('00');
  });
});
