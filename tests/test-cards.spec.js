import { test, expect } from '@playwright/test';

test('Test cards endpoint returns known brands including Discover', async ({ request }) => {
  const response = await request.get('http://localhost:3001/api/test-cards');
  expect(response.ok()).toBeTruthy();

  const body = await response.json();
  expect(body.cards.length).toBeGreaterThan(0);

  const brands = body.cards.map(c => c.brand);
  expect(brands).toContain('VISA');
  expect(brands).toContain('MASTERCARD');
  expect(brands).toContain('AMEX');
  expect(brands).toContain('DISCOVER');
});
