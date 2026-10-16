import { test, expect } from '@playwright/test';

const schemes = ['visa', 'mastercard', 'amex', 'discover'];

for (const scheme of schemes) {
  test(`Field 55 inspector works for ${scheme}`, async ({ request }) => {
    const response = await request.get(`http://localhost:3001/api/field55/inspect?scheme=${scheme}`);
    expect(response.ok()).toBeTruthy();

    const body = await response.json();

    expect(body.scheme).toBe(scheme);
    expect(body.emv.tlv_hex.length).toBeGreaterThan(10);
    expect(body.field55.pretty['9F06']).toBeTruthy(); // AID must exist
  });
}
