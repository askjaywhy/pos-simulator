import { test, expect } from '../fixtures.js';

// Reference spec in the house style. Requires the simulator running (UI :3000, API :3001).
// Card numbers are the simulator's built-in test cards; titles show last 4 only.

test.describe('terminal sale', () => {
  test.beforeEach(async ({ terminal }) => {
    await terminal.goto();
  });

  test('Visa •••• 1111 is approved with response code 00', async ({ terminal }) => {
    await terminal.pay({ number: '4111111111111111', amount: 12.34 });
    await expect(terminal.status).toHaveText('APPROVED');
    await expect(terminal.responseCode).toHaveText('00');
    await expect(terminal.brand).toHaveText('VISA');
    await expect(terminal.resultAmount).toHaveText('$12.34');
  });

  test('Visa •••• 0002 is declined 51 Insufficient Funds', async ({ terminal }) => {
    await terminal.pay({ number: '4000000000000002', amount: 50 });
    await expect(terminal.status).toHaveText('DECLINED');
    await expect(terminal.responseCode).toHaveText('51');
    await expect(terminal.declineReason).toHaveText('Insufficient Funds');
    await expect(terminal.authCode).toHaveText('N/A');
  });

  test('invalid PAN shows the Luhn error and no result', async ({ terminal }) => {
    await terminal.pay({ number: '4111111111111112', amount: 10 });
    await expect(terminal.error).toContainText('Luhn check failed');
    await expect(terminal.status).toBeHidden();
  });

  test('approved sale populates EMV tags and ISO 8583 fields', async ({ terminal }) => {
    await terminal.pay({ number: '4111111111111111', amount: 12.34 });
    await expect(terminal.status).toHaveText('APPROVED');
    await terminal.openEmvTab();
    await expect(terminal.emvRows.first()).toBeVisible();
    await terminal.openIsoTab();
    await expect(terminal.isoRows.first()).toBeVisible();
  });
});
