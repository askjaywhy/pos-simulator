import { test, expect } from '@playwright/test';
import { TEST_EXP } from './support/cards.js';

// Mock SDK phase 1, items 4 + 5: logcat device-log export and the fault -> SDK error map.
const API = 'http://localhost:3001/api';
const THREADTIME = /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} {2}\d+ {2}\d+ [VDIWEF] [A-Za-z]+: /;

async function pay(request, extra = {}, card = '4111111111111111', amount = 75) {
  const res = await request.post(`${API}/transactions/process`, {
    data: { card_number: card, exp_date: TEST_EXP, cvv: '123', amount, ...extra },
  });
  expect(res.status()).toBe(200);
  return res.json();
}
const deviceLog = async (request, id) => {
  const res = await request.get(`${API}/transactions/${id}/device-log`);
  expect(res.status()).toBe(200);
  return { type: res.headers()['content-type'], text: await res.text() };
};
const decodeLog = async (request, log) => (await (await request.post(`${API}/tools/emv-decode`, { data: { log } })).json()).log;

test.beforeEach(async ({ request }) => { await request.delete(`${API}/terminal/config`); });

test.describe('Device log', () => {
  test('text/plain logcat threadtime with SystemInfo, TermConfig and CardReader lines', async ({ request }) => {
    const tx = await pay(request);
    const { type, text } = await deviceLog(request, tx.transaction_id);
    expect(type).toContain('text/plain');
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('--------- beginning of main');
    for (const l of lines.slice(1)) expect(l).toMatch(THREADTIME);
    expect(text).toContain(' I SystemInfo: serial=SIM-0000001');
    expect(text).toContain(' I TermConfig: TID=TERM0001 MID=MERCHANT01');
    expect(text).toContain(' I CardReader: Card inserted');
    expect(text).toContain(' I CardReader: Card removed');
    expect(text).toMatch(/ D EmvKernel: >> C-APDU 00A4/);
    expect(text).toMatch(/ I Comm: 0110 received: DE39 00/);
    expect(text).not.toContain('4111111111111111');
  });

  test('round-trips through the decoder: every APDU exchange and the TVR are found', async ({ request }) => {
    const tx = await pay(request);
    const t = await (await request.get(`${API}/transactions/${tx.transaction_id}/apdu-trace`)).json();
    const { text } = await deviceLog(request, tx.transaction_id);
    const d = await decodeLog(request, text);
    expect(d.exchanges).toHaveLength(t.steps.filter((s) => s.type === 'APDU').length);
    expect(d.exchanges.every((e) => e.sw === '9000')).toBe(true);
    expect(d.values.TVR.value).toBe('0000008000');
    expect(d.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  test('fault shows up in the decoded device log (issuer_auth_failed -> 6300) with its SDK error', async ({ request }) => {
    const tx = await pay(request, { fault: 'issuer_auth_failed' });
    const { text } = await deviceLog(request, tx.transaction_id);
    expect(text).toContain('fault=issuer_auth_failed');
    expect(text).toContain('E EmvKernel: SDK error ERR_ISSUER_AUTH');
    const d = await decodeLog(request, text);
    expect(d.findings.some((f) => /6300/.test(f.message))).toBe(true);
  });

  test('host timeout is logged by Comm at error level', async ({ request }) => {
    const tx = await pay(request, { fault: 'host_timeout' });
    expect((await deviceLog(request, tx.transaction_id)).text).toMatch(/ E Comm: No 0110 within 30 s/);
  });

  test('PIN entry is logged by PinPad (contact offline PIN and contactless online PIN)', async ({ request }) => {
    const a = await pay(request, {}, '4111111111111111', 75);
    expect((await deviceLog(request, a.transaction_id)).text).toMatch(/ I PinPad: CVM: offline plaintext PIN verified/);
    const b = await pay(request, { entry_mode: 'contactless' }, '4111111111111111', 150);
    const text = (await deviceLog(request, b.transaction_id)).text;
    expect(text).toMatch(/ I PinPad: CVM: amount above contactless CVM limit/);
    expect(text).toContain('I CardReader: Card detected in the field (tap)');
  });

  test('contactless card_removed: no response logged, decoder flags it', async ({ request }) => {
    const tx = await pay(request, { entry_mode: 'contactless', fault: 'card_removed' });
    expect(tx).toMatchObject({ status: 'TERMINATED', sdk_error: 'ERR_CARD_REMOVED' });
    const d = await decodeLog(request, (await deviceLog(request, tx.transaction_id)).text);
    expect(d.findings.some((f) => f.severity === 'error' && /no response from card/.test(f.message))).toBe(true);
  });

  test('?format=json returns the lines; unknown id -> 404', async ({ request }) => {
    const tx = await pay(request, { entry_mode: 'fallback' });
    const j = await (await request.get(`${API}/transactions/${tx.transaction_id}/device-log?format=json`)).json();
    expect(j.transaction_id).toBe(tx.transaction_id);
    expect(j.lines.some((l) => /ICC power-on failed: no ATR \(attempt 3\/3\)/.test(l))).toBe(true);
    expect((await request.get(`${API}/transactions/00000000-0000-0000-0000-000000000000/device-log`)).status()).toBe(404);
  });
});

test.describe('SDK error map', () => {
  test('every fault has an sdk_error in GET /faults', async ({ request }) => {
    const { faults } = await (await request.get(`${API}/faults`)).json();
    expect(Object.fromEntries(faults.map((f) => [f.name, f.sdk_error]))).toEqual({
      app_not_found: 'ERR_APP_NOT_FOUND', pin_try_limit: 'ERR_PIN_BLOCKED', malformed_tlv: 'ERR_HOST_FORMAT',
      host_timeout: 'ERR_HOST_TIMEOUT', issuer_91: 'ERR_ISSUER_UNAVAILABLE', issuer_96: 'ERR_HOST_SYSTEM',
      issuer_auth_failed: 'ERR_ISSUER_AUTH', card_removed: 'ERR_CARD_REMOVED',
    });
  });

  test('applied fault: response carries fault.sdk_error and top-level sdk_error', async ({ request }) => {
    const tx = await pay(request, { fault: 'issuer_91' });
    expect(tx.fault.sdk_error).toBe('ERR_ISSUER_UNAVAILABLE');
    expect(tx.sdk_error).toBe('ERR_ISSUER_UNAVAILABLE');
    expect(tx.device_log).toBe(`/api/transactions/${tx.transaction_id}/device-log`);
  });

  test('fault that does not apply: no top-level sdk_error', async ({ request }) => {
    const tx = await pay(request, { fault: 'pin_try_limit' }, '4111111111111111', 20);
    expect(tx.fault.applied).toBe(false);
    expect(tx).not.toHaveProperty('sdk_error');
  });

  test('plain declines are not SDK errors', async ({ request }) => {
    const tx = await pay(request, {}, '4000000000000002', 30);
    expect(tx).not.toHaveProperty('sdk_error');
  });

  test('terminal errors are listed with the config', async ({ request }) => {
    const { terminal_errors } = await (await request.get(`${API}/terminal/config`)).json();
    expect(Object.keys(terminal_errors)).toEqual(['ERR_AID_NOT_SUPPORTED', 'ERR_CTLS_LIMIT_EXCEEDED', 'ERR_CHIP_CARD_SWIPED']);
  });

  test('contactless: PIN and issuer-auth faults do not apply, with a reason', async ({ request }) => {
    const a = await pay(request, { entry_mode: 'contactless', fault: 'pin_try_limit' });
    expect(a.fault).toMatchObject({ applied: false });
    expect(a.fault.note).toContain('online PIN');
    const b = await pay(request, { entry_mode: 'contactless', fault: 'issuer_auth_failed' });
    expect(b).toMatchObject({ status: 'APPROVED' });
    expect(b.fault.applied).toBe(false);
  });

  test('fallback: card-side faults do not apply; host faults do', async ({ request }) => {
    const a = await pay(request, { entry_mode: 'fallback', fault: 'malformed_tlv' });
    expect(a).toMatchObject({ status: 'APPROVED' });
    expect(a.fault.applied).toBe(false);
    const b = await pay(request, { entry_mode: 'fallback', fault: 'host_timeout' });
    expect(b).toMatchObject({ status: 'TIMEOUT_REVERSED', sdk_error: 'ERR_HOST_TIMEOUT' });
    expect(b.reversal.iso8583.mti).toBe('0400');
  });
});
