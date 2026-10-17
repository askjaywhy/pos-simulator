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
    this.submit = page.getByRole('button', { name: 'PROCESS TRANSACTION' });

    // Results — no roles/testids on these divs, so ids are the stable hook (testability gap)
    this.status = page.locator('#result-status');
    this.authCode = page.locator('#result-auth-code');
    this.resultAmount = page.locator('#result-amount');
    this.responseCode = page.locator('#summary-response');
    this.brand = page.locator('#summary-brand');
    this.declineReason = page.locator('#summary-decline');
    this.maskedCard = page.locator('#summary-card');
    this.error = page.locator('#error-message');
    // #id: result fields and header badge have no role/testid (testability gap)
    this.transactionId = page.locator('#result-transaction-id');
    this.backendStatus = page.locator('#backend-status');

    // Headings
    this.paymentFormHeading = page.getByRole('heading', { name: 'Payment Form' });

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

  async selectTestCard(pan) {
    // option values are the raw PANs
    await this.testCardSelect.selectOption(pan);
  }

  // Simulate an unreachable backend. Must be called before goto() so the health poll fails too.
  async failBackend() {
    await this.page.route('http://localhost:3001/api/**', (route) => route.abort());
  }

  // Make the payment request hang (never answered). Other API calls are untouched.
  async hangPayments() {
    await this.page.route('http://localhost:3001/api/transactions/process', () => {});
  }

  // Fake the page clock so timeouts can be reached without real waiting. Call before goto().
  async installClock() {
    await this.page.clock.install();
  }

  async advanceTime(ms) {
    await this.page.clock.fastForward(ms);
  }

  // Waits for the header badge to leave "Checking..." so screenshots are stable.
  async waitForBackendOnline() {
    await expect(this.backendStatus).toContainText('Online');
  }

  // Regions to mask in visual snapshots.
  dynamicRegions() {
    return [this.backendStatus];
  }

  // Native constraint-validation flags of a form field, by page-object member name.
  async validityOf(field) {
    return this[field].evaluate((el) => ({
      valueMissing: el.validity.valueMissing,
      patternMismatch: el.validity.patternMismatch,
      rangeUnderflow: el.validity.rangeUnderflow,
      stepMismatch: el.validity.stepMismatch,
      valid: el.validity.valid,
    }));
  }

  // True when the page has no horizontal overflow.
  async fitsViewportWidth() {
    return this.page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
  }

  async openEmvTab() {
    await this.emvTab.click();
  }

  async openIsoTab() {
    await this.isoTab.click();
  }
}
