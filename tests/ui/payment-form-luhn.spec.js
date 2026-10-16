import { test, expect } from '@playwright/test';

test('Shows error for invalid card number (Luhn)', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.fill('input[name="card_number"]', '4111111111111112'); // invalid
  await page.fill('input[name="exp_date"]', '12/25');
  await page.fill('input[name="cvv"]', '123');
  await page.fill('input[name="amount"]', '10.00');

  await page.click('button:has-text("Pay")');

  await expect(page.locator('text=Luhn check failed')).toBeVisible();
});
