import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 } }); // iPhone-ish

test('Payment form works on mobile viewport', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await expect(page.locator('text=Payment Form')).toBeVisible();

  await page.fill('input[name="card_number"]', '4111111111111111');
  await page.fill('input[name="exp_date"]', '12/25');
  await page.fill('input[name="cvv"]', '123');
  await page.fill('input[name="amount"]', '9.99');
  await page.click('button:has-text("Pay")');

  await expect(page.locator('text=APPROVED')).toBeVisible();
});
