import { test, expect } from '@playwright/test';

test('Processes a Discover transaction', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.fill('input[name="card_number"]', '6011111111111117');
  await page.fill('input[name="exp_date"]', '12/25');
  await page.fill('input[name="cvv"]', '123');
  await page.fill('input[name="amount"]', '20.00');

  await page.click('button:has-text("Pay")');

  await expect(page.locator('text=APPROVED')).toBeVisible();
  await expect(page.locator('text=DISCOVER')).toBeVisible();
});
