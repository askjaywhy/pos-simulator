import { test, expect } from '@playwright/test';

test('Processes an approved Visa transaction', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.fill('input[name="card_number"]', '4111111111111111');
  await page.fill('input[name="exp_date"]', '12/25');
  await page.fill('input[name="cvv"]', '123');
  await page.fill('input[name="amount"]', '12.34');

  await page.click('button:has-text("Pay")');

  await expect(page.locator('text=APPROVED')).toBeVisible();
  await expect(page.locator('text=Response Code: 00')).toBeVisible();
});
