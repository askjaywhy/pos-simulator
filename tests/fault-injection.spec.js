import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// Opt-in fault injection: POST /transactions/process { ..., fault }. GET /faults lists them.
// Each fault produces a realistic card/host failure, a matching APDU trace, and (where a real
// terminal would) a terminal-initiated 0400 reversal.
const API = 'http://localhost:3001/api';
const VISA = '4111111111111111';

async function pay(request, fault, { card = VISA, amount = 75 } = {}) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: card, exp_date: TEST_EXP, cvv: '123', amount, fault },
  });
  return res;
}

async function payOk(request, fault, opts) {
  const res = await pay(request, fault, opts);
  expect(res.status()).toBe(200);
  return res.json();
}

const trace = async (request, id) => (await request.get(`${API}/transactions/${id}/apdu-trace`)).json();
const sw = (t, name) => t.steps.find((s) => s.name === name)?.sw;

test.describe('Fault injection', () => {
  test('GET /faults lists all 8 faults', async ({ request }) => {
    const { faults } = await (await request.get(`${API}/faults`)).json();
    expect(faults.map((f) => f.name)).toEqual(['app_not_found', 'pin_try_limit', 'malformed_tlv', 'host_timeout',
      'issuer_91', 'issuer_96', 'issuer_auth_failed', 'card_removed']);
  });

  test('unknown fault -> 400; empty fault = normal processing', async ({ request }) => {
    const bad = await pay(request, 'nope');
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain('Unknown fault');
    const empty = await payOk(request, '');
    expect(empty.status).toBe('APPROVED');
    expect(empty).not.toHaveProperty('fault');
  });

  test('app_not_found: SELECT 6A82, TERMINATED, no host messages', async ({ request }) => {
    const tx = await payOk(request, 'app_not_found');
    expect(tx).toMatchObject({ success: false, status: 'TERMINATED', response_code: null, iso8583: null, iso8583_response: null });
    expect(tx.fault).toMatchObject({ name: 'app_not_found', applied: true });
    const t = await trace(request, tx.transaction_id);
    expect(sw(t, 'Select application')).toBe('6A82');
    expect(t.steps.some((s) => s.type === 'HOST')).toBe(false);
    expect(t.de55_check).toBeNull();
  });

  test('pin_try_limit: VERIFY 6983, TVR byte 3, issuer declines 75', async ({ request }) => {
    const tx = await payOk(request, 'pin_try_limit');
    expect(tx).toMatchObject({ status: 'DECLINED', response_code: '75', decline_reason: 'Allowable number of PIN tries exceeded' });
    expect(tx.iso8583_response.fields['39'].value).toBe('75');
    const t = await trace(request, tx.transaction_id);
    expect(sw(t, 'Verify offline PIN')).toBe('6983');
    expect(t.summary).toMatchObject({ tvr: '0000A08000', cvm_results: '410301', cid_final: '00' });
  });

  test('pin_try_limit under the No-CVM limit does not apply', async ({ request }) => {
    const tx = await payOk(request, 'pin_try_limit', { amount: 20 });
    expect(tx.status).toBe('APPROVED');
    expect(tx.fault.applied).toBe(false);
    expect(tx.fault.note).toContain('No-CVM limit');
  });

  test('malformed_tlv: DE55 truncated, host 30, emv.tlv_hex intact', async ({ request }) => {
    const tx = await payOk(request, 'malformed_tlv');
    expect(tx).toMatchObject({ status: 'DECLINED', response_code: '30' });
    const de55 = tx.iso8583.fields['55'].value;
    expect(tx.emv.tlv_hex.startsWith(de55)).toBe(true);
    expect(tx.emv.tlv_hex.length - de55.length).toBe(4);
    const t = await trace(request, tx.transaction_id);
    expect(t.de55_check.parse_errors[0].message).toContain('declares 2 bytes but only 0 remain');
  });

  test('host_timeout: no 0110, ARC Z3, AAC, timeout reversal 0400', async ({ request }) => {
    const tx = await payOk(request, 'host_timeout');
    expect(tx).toMatchObject({ status: 'TIMEOUT_REVERSED', response_code: 'Z3', iso8583_response: null, auth_code: null });
    expect(tx.reversal.iso8583.mti).toBe('0400');
    expect(tx.reversal.iso8583.fields['37'].value).toBe(tx.transaction_id.replace(/-/g, '').slice(0, 12).toUpperCase());
    const t = await trace(request, tx.transaction_id);
    expect(t.steps.find((s) => s.name === '2nd Generate AC').c_apdu.slice(10, 14)).toBe('5A33'); // 8A = "Z3"
    expect(t.summary.cid_final).toBe('00');
    expect(t.outcome.reversal_required).toBe(true);
  });

  for (const [fault, code] of [['issuer_91', '91'], ['issuer_96', '96']]) {
    test(`${fault}: 0110 DE39 ${code}, card AAC, no reversal`, async ({ request }) => {
      const tx = await payOk(request, fault);
      expect(tx).toMatchObject({ status: 'DECLINED', response_code: code, auth_code: null });
      expect(tx.iso8583_response.fields['39'].value).toBe(code);
      expect(tx).not.toHaveProperty('reversal');
      expect((await trace(request, tx.transaction_id)).summary.cid_final).toBe('00');
    });
  }

  test('issuer_auth_failed: issuer approves, EXT AUTH 6300, card AAC, reversal', async ({ request }) => {
    const tx = await payOk(request, 'issuer_auth_failed');
    expect(tx).toMatchObject({ success: false, status: 'DECLINED_BY_CARD', response_code: '00' });
    expect(tx.iso8583_response.fields['39'].value).toBe('00');
    expect(tx.reversal.iso8583.mti).toBe('0400');
    const t = await trace(request, tx.transaction_id);
    expect(sw(t, 'External authenticate')).toBe('6300');
    expect(t.summary).toMatchObject({ tvr: '0000008040', cid_final: '00' });
  });

  test('card_removed: no response to 2nd GENERATE AC, reversal', async ({ request }) => {
    const tx = await payOk(request, 'card_removed');
    expect(tx).toMatchObject({ status: 'CARD_REMOVED_REVERSED', response_code: '00' });
    expect(tx.reversal.iso8583.mti).toBe('0400');
    const t = await trace(request, tx.transaction_id);
    const genAc2 = t.steps.find((s) => s.name === '2nd Generate AC');
    expect(genAc2).toMatchObject({ r_apdu: null, sw: null });
    expect(t.summary.cid_final).toBeNull();
  });

  test('post-approval faults do not apply to a declined card', async ({ request }) => {
    const tx = await payOk(request, 'card_removed', { card: '4000000000000002' });
    expect(tx).toMatchObject({ status: 'DECLINED', response_code: '51' });
    expect(tx.fault.applied).toBe(false);
    expect(tx).not.toHaveProperty('reversal');
  });

  test('fault outcomes cannot be refunded or reversed again (422)', async ({ request }) => {
    for (const fault of ['host_timeout', 'card_removed', 'app_not_found']) {
      const tx = await payOk(request, fault);
      expect((await request.post(`${API}/transactions/${tx.transaction_id}/refund`)).status()).toBe(422);
      expect((await request.post(`${API}/transactions/${tx.transaction_id}/reversal`)).status()).toBe(422);
    }
  });

  test('history and details still load with fault transactions present', async ({ request }) => {
    const tx = await payOk(request, 'app_not_found');
    expect((await request.get(`${API}/transactions/history`)).status()).toBe(200);
    const detail = await (await request.get(`${API}/transactions/${tx.transaction_id}`)).json();
    expect(detail).toMatchObject({ status: 'TERMINATED', iso8583_message: null });
  });
});
