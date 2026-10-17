import { test, expect } from '../fixtures.js';

// Native form validation, backend failure, mobile layout and empty-form snapshot.
// Validation messages are browser-native and not in the DOM, so we assert on hidden
// result/error, focus and validity flags only.
const API = 'http://localhost:3001/api';
const VISA_1111 = '4111111111111111';
const DISCOVER_1117 = '6011111111111117';

test.describe('native form validation blocks submission', () => {
  test.beforeEach(async ({ terminal }) => {
    await terminal.goto();
  });

  test('empty form is blocked and focus lands on Card Number', async ({ terminal }) => {
    await terminal.submit.click();
    await expect(terminal.status).toBeHidden();
    await expect(terminal.error).toBeHidden();
    await expect(terminal.cardNumber).toBeFocused();
    expect((await terminal.validityOf('cardNumber')).valueMissing).toBe(true);
  });

  test('only card filled (•••• 1111) is blocked and focus lands on Expiration', async ({ terminal }) => {
    await terminal.cardNumber.fill(VISA_1111);
    await terminal.submit.click();
    await expect(terminal.status).toBeHidden();
    await expect(terminal.error).toBeHidden();
    await expect(terminal.expiry).toBeFocused();
    expect((await terminal.validityOf('expiry')).valueMissing).toBe(true);
  });

  test('expiry "1225" (•••• 1111) is blocked by the pattern', async ({ terminal }) => {
    await terminal.pay({ number: VISA_1111, exp: '1225', amount: 10 });
    await expect(terminal.status).toBeHidden();
    await expect(terminal.error).toBeHidden();
    await expect(terminal.expiry).toBeFocused();
    expect((await terminal.validityOf('expiry')).patternMismatch).toBe(true);
  });

  test('CVV "12" (•••• 1111) is blocked by the pattern', async ({ terminal }) => {
    await terminal.pay({ number: VISA_1111, cvv: '12', amount: 10 });
    await expect(terminal.status).toBeHidden();
    await expect(terminal.error).toBeHidden();
    await expect(terminal.cvv).toBeFocused();
    expect((await terminal.validityOf('cvv')).patternMismatch).toBe(true);
  });

  for (const { label, number, amount, flag } of [
    { label: '0 (•••• 1117)', number: DISCOVER_1117, amount: '0', flag: 'rangeUnderflow' },
    { label: '-5 (•••• 1111)', number: VISA_1111, amount: '-5', flag: 'rangeUnderflow' },
    { label: '0.001 (•••• 1111)', number: VISA_1111, amount: '0.001', flag: 'stepMismatch' },
  ]) {
    test(`amount ${label} is blocked by the browser`, async ({ terminal }) => {
      await terminal.pay({ number, amount });
      await expect(terminal.status).toBeHidden();
      await expect(terminal.error).toBeHidden();
      await expect(terminal.amount).toBeFocused();
      expect((await terminal.validityOf('amount'))[flag]).toBe(true);
    });
  }
});

test.describe('backend unreachable', () => {
  test('sale shows a backend error and no result', async ({ terminal, request }) => {
    await terminal.failBackend();
    await terminal.goto();
    await terminal.pay({ number: VISA_1111, amount: 12.34 });
    await expect(terminal.error).toBeVisible();
    await expect(terminal.error).toContainText('Backend error');
    await expect(terminal.status).toBeHidden();

    // the real backend was never touched and is still healthy
    const health = await request.get(`${API}/health`);
    expect(health.status()).toBe(200);
  });
});

test.describe('phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('form is usable and a Visa •••• 1111 sale completes', async ({ terminal, request }) => {
    await terminal.goto();
    await expect(terminal.paymentFormHeading).toBeVisible();
    for (const field of [terminal.cardNumber, terminal.expiry, terminal.cvv, terminal.amount, terminal.submit]) {
      await expect(field).toBeVisible();
    }
    await terminal.pay({ number: VISA_1111, amount: 9.99 });
    await expect(terminal.status).toBeVisible();
    await expect(terminal.status).toHaveText('APPROVED');
    await expect(terminal.responseCode).toHaveText('00');
    await expect(terminal.brand).toHaveText('VISA');
    await expect(terminal.resultAmount).toHaveText('$9.99');
    expect(await terminal.fitsViewportWidth()).toBe(true);

    const id = (await terminal.transactionId.textContent()).trim();
    const res = await request.get(`${API}/transactions/${id}`);
    const tx = await res.json();
    expect(tx.status).toBe('APPROVED');
    expect(Number(tx.amount)).toBe(9.99);
  });
});

test.describe('visual', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('empty form matches baseline', async ({ terminal }) => {
    await terminal.goto();
    await terminal.waitForBackendOnline();
    await expect(terminal.page).toHaveScreenshot('terminal-empty.png', {
      animations: 'disabled',
      mask: terminal.dynamicRegions(),
    });
  });
});
