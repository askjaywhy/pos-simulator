import { test, expect } from '@playwright/test';

test('Processes a declined transaction (Insufficient Funds)', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.fill('input[name="card_number"]', '4000000000000002');
  await page.fill('input[name="exp_date"]', '12/25');
  await page.fill('input[name="cvv"]', '123');
  await page.fill('input[name="amount"]', '50.00');

  await page.click('button:has-text("Pay")');

  await expect(page.locator('text=DECLINED')).toBeVisible();
  await expect(page.locator('text=Insufficient Funds')).toBeVisible();
});
