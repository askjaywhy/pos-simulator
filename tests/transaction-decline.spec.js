import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

test('Declined transaction matches decline rules', async ({ request }) => {
  const payload = {
    card_number: '4000000000000002',
    exp_date: TEST_EXP,
    cvv: '123',
    amount: 50.00
  };

  const response = await request.post('http://localhost:3001/api/transactions/process', { data: payload });
  expect(response.ok()).toBeTruthy();

  const body = await response.json();

  expect(body.success).toBe(false);
  expect(body.status).toBe('DECLINED');
  expect(body.response_code).toBe('51'); // Insufficient funds
  expect(body.decline_reason).toBe('Insufficient Funds');
});
