import { test, expect } from '@playwright/test';

test('Displays EMV TLV and ISO8583 fields after payment', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.fill('input[name="card_number"]', '4111111111111111');
  await page.fill('input[name="exp_date"]', '12/25');
  await page.fill('input[name="cvv"]', '123');
  await page.fill('input[name="amount"]', '12.34');

  await page.click('button:has-text("Pay")');

  await expect(page.locator('text=TLV')).toBeVisible();
  await expect(page.locator('text=9F06')).toBeVisible(); // AID
  await expect(page.locator('text=ISO8583')).toBeVisible();
  await expect(page.locator('text=MTI')).toBeVisible();
});
