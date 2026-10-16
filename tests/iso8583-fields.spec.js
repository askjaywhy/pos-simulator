import { test, expect } from '@playwright/test';

test('ISO8583 fields endpoint returns field definitions', async ({ request }) => {
  const response = await request.get('http://localhost:3001/api/iso8583-fields');
  expect(response.ok()).toBeTruthy();

  const body = await response.json();
  expect(body.total).toBeGreaterThan(10);

  expect(body.fields['2'].name).toBe('Primary Account Number (PAN)');
  expect(body.fields['55'].name).toBe('Integrated Circuit Card (ICC) Data');
});
