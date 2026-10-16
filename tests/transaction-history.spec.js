import { test, expect } from '@playwright/test';

test('Transaction history returns recent transactions', async ({ request }) => {
  const response = await request.get('http://localhost:3001/api/transactions/history');
  expect(response.ok()).toBeTruthy();

  const body = await response.json();
  expect(body.transactions.length).toBeGreaterThan(0);

  const tx = body.transactions[0];
  expect(tx.card_brand).toBeTruthy();
  expect(tx.emv_tags).toBeTruthy();
});
