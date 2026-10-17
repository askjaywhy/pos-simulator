import { expect } from '@playwright/test';

// Page object for the POS terminal UI (frontend/index.html).
// All UI locators for the agent-built suite live here. The healer may edit this file;
// every edit is logged to heal-log/heals.jsonl.
export class TerminalPage {
  constructor(page) {
    this.page = page;

    // Form — inputs have <label for>, so getByLabel is stable
    this.testCardSelect = page.getByLabel('Test Cards:');
    this.cardNumber = page.getByLabel('Card Number:');
    this.expiry = page.getByLabel('Expiration (MM/YY):');
    this.cvv = page.getByLabel('CVV:');
    this.amount = page.getByLabel('Amount ($):');
    this.submit = page.getByRole('button', { name: 'CHARGE' });

    // Results — no roles/testids on these divs, so ids are the stable hook (testability gap)
    this.status = page.locator('#result-status');
    this.authCode = page.locator('#result-auth-code');
    this.resultAmount = page.locator('#result-amount');
    this.responseCode = page.locator('#summary-response');
    this.brand = page.locator('#summary-brand');
    this.declineReason = page.locator('#summary-decline');
    this.maskedCard = page.locator('#summary-card');
    this.error = page.locator('#error-message');

    // Tabs
    this.emvTab = page.getByRole('button', { name: 'EMV Tags' });
    this.isoTab = page.getByRole('button', { name: 'ISO 8583' });
    this.emvRows = page.locator('#emv-tags-body tr');
    this.isoRows = page.locator('#iso8583-fields-body tr');
  }

  async goto() {
    await this.page.goto('http://localhost:3000');
    await expect(this.submit).toBeVisible();
  }

  async pay({ number, exp = '12/25', cvv = '123', amount }) {
    await this.cardNumber.fill(number);
    await this.expiry.fill(exp);
    await this.cvv.fill(cvv);
    await this.amount.fill(String(amount));
    await this.submit.click();
  }

  async openEmvTab() {
    await this.emvTab.click();
  }

  async openIsoTab() {
    await this.isoTab.click();
  }
}
