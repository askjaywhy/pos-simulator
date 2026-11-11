import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// DEF-008 regression: the primary bitmap must mark exactly the data elements present.
// hex_message = MTI (4 chars) + primary bitmap (16 hex chars = 64 bits, bit 1 = MSB) + fields.
const API = 'http://localhost:3001/api';

function bitsFromBitmap(hex16) {
  const value = BigInt('0x' + hex16);
  const bits = [];
  for (let bit = 1; bit <= 64; bit++) {
    if ((value >> BigInt(64 - bit)) & 1n) bits.push(bit);
  }
  return bits;
}

function fieldsPresent(isoFields) {
  return Object.entries(isoFields)
    .filter(([, f]) => f.value !== '' && f.value != null)
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
}

test.describe('ISO 8583 primary bitmap (DEF-008)', () => {
  for (const [label, pan] of [['approved •••• 1111', '4111111111111111'], ['declined •••• 0002', '4000000000000002']]) {
    test(`bitmap matches the fields present (${label})`, async ({ request }) => {
      const res = await request.post(`${API}/transactions/process`, {
        data: { card_number: pan, exp_date: TEST_EXP, cvv: '123', amount: 10.0 },
      });
      expect(res.ok()).toBeTruthy();
      const { iso8583 } = await res.json();
      const bitmap = iso8583.hex_message.slice(4, 20);

      // DE2, 4, 11, 12, 13, 39, 49, 55
      expect(bitmap).toBe('5038000002008200');
      expect(bitsFromBitmap(bitmap)).toEqual(fieldsPresent(iso8583.fields));
    });
  }

  test('field55 inspect message has a consistent bitmap too', async ({ request }) => {
    const { iso8583 } = await (await request.get(`${API}/field55/inspect?scheme=visa`)).json();
    expect(iso8583.bitmap).toBe(iso8583.hex_message.slice(4, 20));
    expect(bitsFromBitmap(iso8583.bitmap)).toEqual(fieldsPresent(iso8583.fields));
  });
});
