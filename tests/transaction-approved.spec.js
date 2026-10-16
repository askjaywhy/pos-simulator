import { test, expect } from '@playwright/test';

test('Approved Visa transaction processes successfully', async ({ request }) => {
  const payload = {
    card_number: '4111111111111111',
    exp_date: '12/25',
    cvv: '123',
    amount: 12.34
  };

  const response = await request.post('http://localhost:3001/api/transactions/process', { data: payload });
  expect(response.ok()).toBeTruthy();

  const body = await response.json();

  expect(body.success).toBe(true);
  expect(body.status).toBe('APPROVED');
  expect(body.response_code).toBe('00');
  expect(body.card_brand).toBe('VISA');
  expect(body.emv.tlv_hex.length).toBeGreaterThan(10);
});
