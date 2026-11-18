import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// APDU trace + EMV decoder: GET /transactions/:id/apdu-trace and POST /tools/emv-decode.
// The trace is additive: the default /process response keeps its exact key set.
const API = 'http://localhost:3001/api';

async function pay(request, card, amount, extra = {}) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: card, exp_date: TEST_EXP, cvv: '123', amount, ...extra },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

async function trace(request, id) {
  const res = await request.get(`${API}/transactions/${id}/apdu-trace`);
  expect(res.status()).toBe(200);
  return res.json();
}

const decode = (request, data) => request.post(`${API}/tools/emv-decode`, { data });

const DEFAULT_KEYS = ['success', 'transaction_id', 'status', 'response_code', 'decline_reason', 'auth_code', 'amount',
  'currency', 'timestamp', 'card_masked', 'card_brand', 'emv', 'iso8583', 'iso8583_response'];

test.describe('APDU trace', () => {
  test('default /process response is unchanged (no fault keys)', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75);
    expect(Object.keys(tx).sort()).toEqual([...DEFAULT_KEYS].sort());
  });

  test('approved Visa: full contact flow ending in a TC', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75);
    const t = await trace(request, tx.transaction_id);
    expect(t.fault).toBeNull();
    expect(t.outcome).toMatchObject({ status: 'APPROVED', response_code: '00', reversal_required: false });
    const names = t.steps.filter((s) => s.type === 'APDU').map((s) => s.name);
    expect(names).toEqual(['Select PSE', 'Read PSE directory', 'Select application', 'Get processing options',
      'Read record', 'Read record', 'Internal authenticate (DDA)', 'Get data: PIN try counter', 'Verify offline PIN',
      '1st Generate AC', 'External authenticate', '2nd Generate AC']);
    expect(t.steps.filter((s) => s.type === 'APDU').every((s) => s.sw === '9000')).toBe(true);
    expect(t.summary).toMatchObject({ tvr: '0000008000', tsi: 'F800', cvm_results: '410302', cid_first: '80', cid_final: '40' });
    expect(t.summary.explained.cid_final.cryptogram).toBe('TC (approved offline)');
  });

  test('trace uses the scheme AID and the 0100 cryptogram', async ({ request }) => {
    const tx = await pay(request, '5555555555554444', 12.34);
    const t = await trace(request, tx.transaction_id);
    expect(t.aid).toBe('A0000000041010');
    const select = t.steps.find((s) => s.name === 'Select application');
    expect(select.c_apdu).toBe('00A4040007A000000004101000');
    const genAc1 = t.steps.find((s) => s.name === '1st Generate AC');
    expect(genAc1.r_apdu).toContain('9F2608' + tx.emv.tags['9F26'].value);
  });

  test('under 50.00 the CVM list waives CVM: no VERIFY', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 20);
    const t = await trace(request, tx.transaction_id);
    expect(t.summary.cvm_results).toBe('1F0602');
    expect(t.steps.some((s) => s.command === 'VERIFY')).toBe(false);
  });

  test('declined card: card returns an AAC with the host ARC', async ({ request }) => {
    const tx = await pay(request, '4000000000000002', 30);
    const t = await trace(request, tx.transaction_id);
    expect(t.outcome).toMatchObject({ status: 'DECLINED', response_code: '51' });
    const genAc2 = t.steps.find((s) => s.name === '2nd Generate AC');
    expect(genAc2.c_apdu.slice(0, 14)).toBe('80AE00001F3531'); // AAC requested, 8A = "51"
    expect(t.summary.cid_final).toBe('00');
  });

  test('expired card sets TVR "Expired application"', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 30, { exp_date: '01/20' });
    expect(tx.response_code).toBe('54');
    const t = await trace(request, tx.transaction_id);
    expect(t.summary.explained.tvr.set.map((b) => b.meaning)).toContain('Expired application');
  });

  test('PAN is masked and PIN blocks are never logged in clear', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75);
    const t = await trace(request, tx.transaction_id);
    const all = JSON.stringify(t);
    expect(all).not.toContain('4111111111111111');
    expect(all).toContain('5A08411111FFFFFF1111');
    expect(t.steps.find((s) => s.command === 'VERIFY').c_apdu).toContain('24****');
  });

  test('log lines are logcat-style with C-APDU / R-APDU', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75);
    const t = await trace(request, tx.transaction_id);
    expect(t.log[1]).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} D EMVKernel: >> C-APDU 00A4/);
    expect(t.log.at(-1)).toContain('Transaction result: APPROVED');
  });

  test('de55_check: the 0100 DE55 has every commonly required tag (B1)', async ({ request }) => {
    const tx = await pay(request, '4111111111111111', 75);
    const t = await trace(request, tx.transaction_id);
    expect(t.de55_check).toMatchObject({ ok: true, parse_errors: [], missing_required: [] });
  });

  test('unknown transaction -> 404', async ({ request }) => {
    const res = await request.get(`${API}/transactions/00000000-0000-0000-0000-000000000000/apdu-trace`);
    expect(res.status()).toBe(404);
  });
});

test.describe('EMV decode tool', () => {
  test('decodes TVR, TSI, CVM Results, CID and SW', async ({ request }) => {
    const res = await decode(request, { tvr: '0000208040', tsi: 'F800', cvm_results: '410301', cid: '80', sw: '6A82' });
    expect(res.status()).toBe(200);
    const d = await res.json();
    expect(d.tvr.set.map((b) => `${b.byte}.${b.bit}`)).toEqual(['3.6', '4.8', '5.7']);
    expect(d.tsi.set).toHaveLength(5);
    expect(d.cvm_results).toMatchObject({ method: 'Plaintext PIN verified by ICC', result: 'Failed' });
    expect(d.cid.cryptogram).toBe('ARQC (go online)');
    expect(d.sw).toMatchObject({ ok: false, meaning: 'File or application not found' });
  });

  test('TLV with nested templates is parsed and explained', async ({ request }) => {
    const d = await (await decode(request, { tlv_hex: '770F9F2701409F360200019F3403410302' })).json();
    expect(d.tlv_hex.ok).toBe(true);
    expect(d.tlv_hex.items[0].children.map((c) => c.tag)).toEqual(['9F27', '9F36', '9F34']);
    expect(d.tlv_hex.explained['9F27'].cryptogram).toBe('TC (approved offline)');
  });

  test('truncated TLV reports the tag and offset', async ({ request }) => {
    const d = await (await decode(request, { tlv_hex: '9F0607A00000000310109F2608ABCD' })).json();
    expect(d.tlv_hex.ok).toBe(false);
    expect(d.tlv_hex.errors[0]).toMatchObject({ offset: 10, tag: '9F26' });
  });

  test('APDU log: finds error status words and missing responses', async ({ request }) => {
    const log = [
      'D/CtlsSDK: >> 00A4040007 A0000000031010 00',
      'D/CtlsSDK: << 6A 82',
      'D/CtlsSDK: >> 80AE80001D00',
      'D/CtlsSDK: << NO RESPONSE',
    ].join('\n');
    const d = await (await decode(request, { log })).json();
    expect(d.log.exchanges.map((e) => e.sw)).toEqual(['6A82', null]);
    expect(d.log.findings.filter((f) => f.severity === 'error')).toHaveLength(2);
  });

  test('bad input is reported per item; empty body -> 400', async ({ request }) => {
    const d = await (await decode(request, { tvr: '00' })).json();
    expect(d.tvr.error).toBe('TVR: expected 5 bytes, got 1');
    expect((await decode(request, {})).status()).toBe(400);
  });
});
