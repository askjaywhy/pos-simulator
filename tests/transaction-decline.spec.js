import { test, expect } from '@playwright/test';

test('Declined transaction matches decline rules', async ({ request }) => {
  const payload = {
    card_number: '4000000000000002',
    exp_date: '12/25',
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
