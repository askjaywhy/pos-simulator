import { test, expect } from '../fixtures.js';

// Card-outcome coverage. Full PANs live only in this constant block; titles use the last 4.
// Requires the simulator running (UI :3000, API :3001).
const API = 'http://localhost:3001/api';
const PAN = {
  mc4444: '5555555555554444',
  amex0005: '378282246310005',
  discover1117: '6011111111111117',
  lost9987: '4000000000009987',
};

async function fetchTransaction(request, terminal) {
  const id = (await terminal.transactionId.textContent()).trim();
  const res = await request.get(`${API}/transactions/${id}`);
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe('terminal card outcomes', () => {
  test.beforeEach(async ({ terminal }) => {
    await terminal.goto();
  });

  test('Discover •••• 1117 is approved and identified as Discover', async ({ terminal, request }) => {
    await terminal.pay({ number: PAN.discover1117, amount: 20.0 });
    await expect(terminal.status).toHaveText('APPROVED');
    await expect(terminal.responseCode).toHaveText('00');
    await expect(terminal.brand).toHaveText('DISCOVER');
    await expect(terminal.declineReason).toHaveText('N/A');
    await expect(terminal.resultAmount).toHaveText('$20.00');
    await expect(terminal.authCode).toHaveText(/^AUTH[0-9A-F]{6}$/);

    const tx = await fetchTransaction(request, terminal);
    expect(tx.status).toBe('APPROVED');
    expect(tx.response_code).toBe('00');
    expect(tx.card_brand).toBe('DISCOVER');
    expect(Number(tx.amount)).toBe(20);
  });

  for (const { last4, pan, brand } of [
    { last4: '4444', pan: PAN.mc4444, brand: 'MASTERCARD' },
    { last4: '0005', pan: PAN.amex0005, brand: 'AMEX' },
  ]) {
    test(`${brand} •••• ${last4} is approved with brand ${brand}`, async ({ terminal, request }) => {
      await terminal.pay({ number: pan, amount: 15.0 });
      await expect(terminal.status).toHaveText('APPROVED');
      await expect(terminal.responseCode).toHaveText('00');
      await expect(terminal.brand).toHaveText(brand);
      await expect(terminal.declineReason).toHaveText('N/A');
      await expect(terminal.resultAmount).toHaveText('$15.00');

      const tx = await fetchTransaction(request, terminal);
      expect(tx.card_brand).toBe(brand);
    });
  }

  test('Lost Card •••• 9987 is declined with 41', async ({ terminal, request }) => {
    await terminal.pay({ number: PAN.lost9987, amount: 20.0 });
    await expect(terminal.status).toHaveText('DECLINED');
    await expect(terminal.responseCode).toHaveText('41');
    await expect(terminal.declineReason).toHaveText('Lost Card');
    await expect(terminal.brand).toHaveText('VISA');
    await expect(terminal.authCode).toHaveText('N/A');
    await expect(terminal.resultAmount).toHaveText('$20.00');
    await expect(terminal.error).toBeHidden();

    const tx = await fetchTransaction(request, terminal);
    expect(tx.status).toBe('DECLINED');
    expect(tx.response_code).toBe('41');
    expect(tx.auth_code).toBeNull();
  });

  test('selecting test card •••• 1117 from the dropdown fills the card number', async ({ terminal }) => {
    await terminal.selectTestCard(PAN.discover1117);
    await expect(terminal.cardNumber).toHaveValue(PAN.discover1117);

    await terminal.expiry.fill('12/25');
    await terminal.cvv.fill('123');
    await terminal.amount.fill('20');
    await terminal.submit.click();
    await expect(terminal.status).toHaveText('APPROVED');
    await expect(terminal.brand).toHaveText('DISCOVER');
  });
});
