import { test, expect } from '@playwright/test';

test('Payment form visual snapshot', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await page.waitForTimeout(500); // let fonts/layout settle

  await expect(page).toHaveScreenshot('payment-form.png');
});

test('Approved transaction visual snapshot', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.fill('input[name="card_number"]', '4111111111111111');
  await page.fill('input[name="exp_date"]', '12/25');
  await page.fill('input[name="cvv"]', '123');
  await page.fill('input[name="amount"]', '12.34');
  await page.click('button:has-text("Pay")');

  await expect(page).toHaveScreenshot('payment-approved.png');
});
