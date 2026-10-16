import { test, expect } from '@playwright/test';

test('API health check returns healthy status', async ({ request }) => {
  const response = await request.get('http://localhost:3001/api/health');
  expect(response.ok()).toBeTruthy();

  const body = await response.json();
  expect(body.status).toBe('healthy');
  expect(body.timestamp).toBeTruthy();
});
