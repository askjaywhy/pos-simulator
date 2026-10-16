import { test, expect } from '@playwright/test';

test('Payment form loads correctly', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await expect(page.locator('text=Payment Form')).toBeVisible();
  await expect(page.locator('input[name="card_number"]')).toBeVisible();
  await expect(page.locator('input[name="exp_date"]')).toBeVisible();
  await expect(page.locator('input[name="cvv"]')).toBeVisible();
  await expect(page.locator('input[name="amount"]')).toBeVisible();
  await expect(page.locator('button:has-text("Pay")')).toBeVisible();
});
