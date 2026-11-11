import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// DEF-003 regression (PCI DSS): the full PAN must never leave the simulator.
// DE2 is truncated to first 6 / last 4 in the response, in hex_message and in storage.
const API = 'http://localhost:3001/api';
const PAN = '4111111111111111';
const MASKED = '411111******1111';
// hex_message hex-encodes each field's ASCII, so the PAN would appear as 3431313131...
const asciiHex = (s) => Buffer.from(s, 'ascii').toString('hex').toUpperCase();

async function pay(request) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: PAN, exp_date: TEST_EXP, cvv: '123', amount: 12.0 },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.describe('PAN masking (DEF-003)', () => {
  test('DE2 in the authorization response is first 6 + last 4', async ({ request }) => {
    const tx = await pay(request);
    expect(tx.iso8583.fields['2'].value).toBe(MASKED);
  });

  test('hex_message carries the truncated PAN, not the full PAN', async ({ request }) => {
    const tx = await pay(request);
    expect(tx.iso8583.hex_message).not.toContain(asciiHex(PAN));
    expect(tx.iso8583.hex_message).toContain(asciiHex(MASKED));
  });

  test('stored transaction and its ISO view never contain the full PAN', async ({ request }) => {
    const tx = await pay(request);
    for (const path of [`/transactions/${tx.transaction_id}`, `/transactions/${tx.transaction_id}/iso8583`]) {
      const res = await request.get(`${API}${path}`);
      expect(res.ok()).toBeTruthy();
      const raw = await res.text();
      expect(raw).not.toContain(PAN);
      expect(raw).not.toContain(asciiHex(PAN));
    }
  });

  test('transaction history never contains the full PAN', async ({ request }) => {
    await pay(request);
    const raw = await (await request.get(`${API}/transactions/history`)).text();
    expect(raw).not.toContain(PAN);
    expect(raw).not.toContain(asciiHex(PAN));
  });

  test('field55 inspect demo message is truncated too', async ({ request }) => {
    const body = await (await request.get(`${API}/field55/inspect?scheme=visa`)).json();
    expect(body.iso8583.fields['2'].value).toBe(MASKED);
  });
});
