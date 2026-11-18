import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// Mock SDK phase 1, item 2: terminal profile (GET/PUT/DELETE /api/terminal/config).
// Defaults equal the simulator's previous constants. Every test restores the defaults.
const API = 'http://localhost:3001/api';
const VISA = '4111111111111111';

const setCfg = (request, data) => request.put(`${API}/terminal/config`, { data });
async function pay(request, extra = {}, amount = 75) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: VISA, exp_date: TEST_EXP, cvv: '123', amount, ...extra },
  });
  expect(res.status()).toBe(200);
  return res.json();
}
const trace = async (request, id) => (await request.get(`${API}/transactions/${id}/apdu-trace`)).json();

test.beforeEach(async ({ request }) => { await request.delete(`${API}/terminal/config`); });
test.afterEach(async ({ request }) => { await request.delete(`${API}/terminal/config`); });

test.describe('Terminal config', () => {
  test('defaults equal the previous hard-coded values', async ({ request }) => {
    const { config, defaults } = await (await request.get(`${API}/terminal/config`)).json();
    expect(config).toEqual(defaults);
    expect(config).toMatchObject({
      terminal_id: 'TERM0001', merchant_id: 'MERCHANT01', country_code: '0840', floor_limit_minor: 0,
      capk_indexes: ['09'], aids: ['A0000000031010', 'A0000000041010', 'A00000002501', 'A0000001523010'],
    });
  });

  test('terminal_id drives DE41; merchant_id is the default DE42', async ({ request }) => {
    expect((await setCfg(request, { terminal_id: 'KIOSK042', merchant_id: 'STORE77' })).status()).toBe(200);
    const tx = await pay(request);
    expect(tx.iso8583.fields['41'].value).toBe('KIOSK042');
    expect(tx.iso8583.fields['42'].value).toBe('STORE77'.padEnd(15, ' '));
    const explicit = await pay(request, { merchant_id: 'OVERRIDE1' });
    expect(explicit.iso8583.fields['42'].value).toBe('OVERRIDE1'.padEnd(15, ' '));
  });

  test('country_code drives 9F1A', async ({ request }) => {
    await setCfg(request, { country_code: '0124' });
    expect((await pay(request)).emv.tags['9F1A'].value).toBe('0124');
  });

  test('AID removed from the profile: TERMINATED, ERR_AID_NOT_SUPPORTED, no SELECT AID', async ({ request }) => {
    await setCfg(request, { aids: ['A0000000041010'] });
    const tx = await pay(request);
    expect(tx).toMatchObject({ status: 'TERMINATED', response_code: null, sdk_error: 'ERR_AID_NOT_SUPPORTED', iso8583: null });
    const t = await trace(request, tx.transaction_id);
    expect(t.steps.some((s) => s.name === 'Select application')).toBe(false);
  });

  test('CAPK missing: DDA failed in TVR (byte 1 bit 4), no INTERNAL AUTHENTICATE, still approved', async ({ request }) => {
    await setCfg(request, { capk_indexes: ['92'] });
    const tx = await pay(request);
    expect(tx.status).toBe('APPROVED');
    expect(tx.emv.tags['95'].value).toBe('0800008000');
    const t = await trace(request, tx.transaction_id);
    expect(t.steps.some((s) => s.name === 'Internal authenticate (DDA)')).toBe(false);
    expect(t.summary.explained.tvr.set.map((b) => b.meaning)).toContain('DDA failed');
  });

  test('CAPK missing (contactless): fDDA failed in TVR', async ({ request }) => {
    await setCfg(request, { capk_indexes: [] });
    const tx = await pay(request, { entry_mode: 'contactless' });
    expect(tx.emv.tags['95'].value).toBe('0800008000');
  });

  test('floor limit above the amount: TVR byte 4 bit 8 not set (still online)', async ({ request }) => {
    await setCfg(request, { floor_limit_minor: 10000 });
    const tx = await pay(request);
    expect(tx).toMatchObject({ status: 'APPROVED' });
    expect(tx.emv.tags['95'].value).toBe('0000000000');
    expect(tx.iso8583_response.mti).toBe('0110');
  });

  test('contactless CVM limit lowered: online PIN at 20.00', async ({ request }) => {
    await setCfg(request, { contactless_cvm_limit_minor: 1500 });
    const tx = await pay(request, { entry_mode: 'contactless' }, 20);
    expect((await trace(request, tx.transaction_id)).summary.cvm_results).toBe('420300');
  });

  test('contactless transaction limit: above it TERMINATED ERR_CTLS_LIMIT_EXCEEDED; chip unaffected', async ({ request }) => {
    await setCfg(request, { contactless_transaction_limit_minor: 5000 });
    const ctls = await pay(request, { entry_mode: 'contactless' });
    expect(ctls).toMatchObject({ status: 'TERMINATED', sdk_error: 'ERR_CTLS_LIMIT_EXCEEDED', emv: null, iso8583: null });
    expect((await pay(request, { entry_mode: 'chip' })).status).toBe('APPROVED');
    expect((await pay(request, { entry_mode: 'contactless' }, 50)).status).toBe('APPROVED');
  });

  test('invalid or unknown keys -> 400 and nothing changes', async ({ request }) => {
    const res = await setCfg(request, { floor_limit_minor: 'x', bogus: 1, terminal_id: 'OK1' });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.details).toEqual(expect.arrayContaining(['unknown key: bogus']));
    expect((await (await request.get(`${API}/terminal/config`)).json()).config.terminal_id).toBe('TERM0001');
    expect((await setCfg(request, { kernel_versions: {} })).status()).toBe(400);
    expect((await setCfg(request, { aids: [] })).status()).toBe(400);
  });

  test('DELETE and /admin/reset restore the defaults', async ({ request }) => {
    await setCfg(request, { terminal_id: 'X1' });
    await request.delete(`${API}/terminal/config`);
    expect((await (await request.get(`${API}/terminal/config`)).json()).config.terminal_id).toBe('TERM0001');
    await setCfg(request, { terminal_id: 'X2' });
    await request.post(`${API}/admin/reset`);
    expect((await (await request.get(`${API}/terminal/config`)).json()).config.terminal_id).toBe('TERM0001');
  });

  test('/field55/inspect uses the profile', async ({ request }) => {
    await setCfg(request, { country_code: '0826' });
    const body = await (await request.get(`${API}/field55/inspect?scheme=visa`)).json();
    expect(body.field55.decoded['9F1A']).toBe('0826');
  });
});
