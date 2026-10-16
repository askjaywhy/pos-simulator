import { test, expect } from '@playwright/test';

test('EMV tags endpoint returns full tag list', async ({ request }) => {
  const response = await request.get('http://localhost:3001/api/emv-tags');
  expect(response.ok()).toBeTruthy();

  const body = await response.json();
  expect(body.total).toBeGreaterThan(10);

  // Check for common EMV tags
  expect(body.tags['9F06']).toBeTruthy();
  expect(body.tags['9F26']).toBeTruthy();
  expect(body.tags['95']).toBeTruthy();
});
