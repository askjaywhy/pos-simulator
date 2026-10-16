import { test, expect } from '@playwright/test';

test('Shows validation errors for missing fields', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.click('button:has-text("Pay")');

  await expect(page.locator('text=Missing required fields')).toBeVisible();
});
