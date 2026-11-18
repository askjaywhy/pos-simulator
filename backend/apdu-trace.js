// apdu-trace.js
// Builds an EMV kernel trace (C-APDU / R-APDU with status words, host messages and terminal
// decisions) for a processed transaction, plus the opt-in fault catalogue.
//
// Three interfaces:
//   contact      - default (and entry_mode "chip"): PSE, GPO, records, DDA, CVM, TRM, 1st/2nd GENERATE AC
//   contactless  - entry_mode "contactless": PPSE, GPO with TTQ (cryptogram in the GPO response,
//                  Kernel C-2/C-3 style), records, fDDA, CVM limit, online; no 2nd GENERATE AC
//   magstripe    - entry_mode "swipe" / "fallback": no chip data; a chip card swiped directly is refused
//
// The trace is a simulation of the card <-> terminal dialogue around the existing host decision.
// With no fault and the default terminal config it never changes the authorization result.
// Terminal config (terminal-config.js) can: drop an AID (ERR_AID_NOT_SUPPORTED), drop a CAPK
// (DDA/fDDA failed in TVR), move the floor limit, and set contactless CVM / transaction limits.
//
// PCI: the PAN in record data is masked with F nibbles (first 6 / last 4 kept) and PIN blocks
// are never logged in clear. Cryptograms, ARPCs and SDAD are deterministic placeholders.

const crypto = require('crypto');
const { buildTLV, CARD_AIP, atcFromStan } = require('./emv-iso8583');
const { decodeTVR, decodeTSI, decodeCVMResults, decodeCID, decodeSW, commandName } = require('./emv-decoder');
const terminalConfig = require('./terminal-config');

// ------------------------
// Fault catalogue
// ------------------------
// stage: where the fault bites. "card" faults change the card dialogue, "host" faults replace
// the host decision, "post_auth" faults only apply after an issuer approval (fault_applied=false otherwise).
// sdk_error: the error code a terminal SDK would surface for it (phase 2 mock SDK maps these).
const FAULTS = {
  app_not_found: {
    stage: 'card',
    sdk_error: 'ERR_APP_NOT_FOUND',
    description: 'SELECT of the terminal\'s AID returns 6A82: the card does not carry that AID. Transaction terminates before any host message. (Contact and contactless.)',
    expected: { status: 'TERMINATED', response_code: null }
  },
  pin_try_limit: {
    stage: 'card',
    sdk_error: 'ERR_PIN_BLOCKED',
    description: 'Offline PIN is blocked: GET DATA 9F17 returns 00 and VERIFY returns 6983. TVR byte 3 flags the failure, the terminal still goes online, the issuer declines 75. Contact only, and only above the card\'s No-CVM limit (50.00).',
    expected: { status: 'DECLINED', response_code: '75' }
  },
  malformed_tlv: {
    stage: 'host',
    sdk_error: 'ERR_HOST_FORMAT',
    description: 'The terminal\'s message packer truncates DE55 (last 2 bytes lost). The host cannot parse ICC data and rejects with 30 (format error). Compare emv.tlv_hex with iso8583.fields[55] to spot it. Chip and contactless only.',
    expected: { status: 'DECLINED', response_code: '30' }
  },
  host_timeout: {
    stage: 'host',
    sdk_error: 'ERR_HOST_TIMEOUT',
    description: 'The 0100 is sent but no 0110 arrives within 30 s. The terminal completes with ARC Z3 (unable to go online) and sends a timeout reversal (0400) for the unanswered request. All interfaces.',
    expected: { status: 'TIMEOUT_REVERSED', response_code: 'Z3' }
  },
  issuer_91: {
    stage: 'host',
    sdk_error: 'ERR_ISSUER_UNAVAILABLE',
    description: 'Host responds 91 (issuer or switch inoperative). All interfaces.',
    expected: { status: 'DECLINED', response_code: '91' }
  },
  issuer_96: {
    stage: 'host',
    sdk_error: 'ERR_HOST_SYSTEM',
    description: 'Host responds 96 (system malfunction). All interfaces.',
    expected: { status: 'DECLINED', response_code: '96' }
  },
  issuer_auth_failed: {
    stage: 'post_auth',
    sdk_error: 'ERR_ISSUER_AUTH',
    description: 'Issuer approves (00), but EXTERNAL AUTHENTICATE returns 6300 (ARPC did not verify). TVR byte 5 flags it, the card declines with an AAC at 2nd GENERATE AC, and the terminal must reverse the approved auth (0400). Contact only, and only when the issuer approves.',
    expected: { status: 'DECLINED_BY_CARD', response_code: '00' }
  },
  card_removed: {
    stage: 'post_auth',
    sdk_error: 'ERR_CARD_REMOVED',
    description: 'Contact: issuer approves (00), but the card is pulled before 2nd GENERATE AC; with no TC the terminal reverses (0400) -> CARD_REMOVED_REVERSED. Contactless: the card leaves the field during READ RECORD -> TERMINATED before any host message ("present card again").',
    expected: { status: 'CARD_REMOVED_REVERSED', response_code: '00', contactless: { status: 'TERMINATED', response_code: null } }
  }
};

// SDK error codes for terminal-side outcomes that are not faults
const TERMINAL_ERRORS = {
  ERR_AID_NOT_SUPPORTED: 'Card AID is not in the terminal profile (candidate list empty)',
  ERR_CTLS_LIMIT_EXCEEDED: 'Amount is above the contactless transaction limit: insert or swipe the card',
  ERR_CHIP_CARD_SWIPED: 'Chip card swiped (service code 2xx): insert the card'
};

function listFaults() {
  return Object.entries(FAULTS).map(([name, f]) => ({ name, stage: f.stage, sdk_error: f.sdk_error, description: f.description, expected: f.expected }));
}

// ------------------------
// Card profile (per scheme)
// ------------------------
const NO_CVM_LIMIT_MINOR = 5000; // CVM list amount X: No CVM required under 50.00
const CVM_LIST = '00001388' + '00000000' + '1F06' + '4103' + '1E03'; // X=50.00, Y=0; No CVM <X, offline PIN, signature
const CDOL1 = '9F02069F03069F1A0295055F2A029A039C019F3704';
const CDOL2 = '8A02' + CDOL1;
const PDOL = '9F02065F2A029A039C019F3704';
const CTLS_PDOL = '9F6604' + '9F0206' + '9F0306' + '9F1A02' + '9505' + '5F2A02' + '9A03' + '9C01' + '9F3704'; // TTQ, amount, other, country, TVR, currency, date, type, UN
const AIP = CARD_AIP; // DDA, cardholder verification, terminal risk management, issuer authentication supported
const AFL = '08010100' + '10010101'; // SFI 1 rec 1; SFI 2 rec 1 (used in ODA)
const CTLS_AFL = '18010101'; // SFI 3 rec 1 (used in fDDA)
const IAD = '06010A03A00000';
const CARD_CAPK = '09';
const TTQ = '36004000'; // qVSDC/EMV mode, contact chip, online PIN, signature; CDCVM supported
const KERNELS = { visa: { id: '03', name: 'C-3' }, mastercard: { id: '02', name: 'C-2' }, amex: { id: '04', name: 'C-4' }, discover: { id: '06', name: 'C-6' } };

const LABELS = { visa: 'VISA CREDIT', mastercard: 'MASTERCARD', amex: 'AMERICAN EXPRESS', discover: 'DISCOVER' };
const ascii = (s) => Buffer.from(s, 'ascii').toString('hex').toUpperCase();
const h = (n, bytes) => n.toString(16).toUpperCase().padStart(bytes * 2, '0');
const bcd = (digits, bytes) => String(digits).padStart(bytes * 2, '0').slice(-bytes * 2);
const fakeHex = (seed, bytes) => crypto.createHash('sha256').update(String(seed)).digest('hex').toUpperCase().slice(0, bytes * 2);
const money = (minor) => (minor / 100).toFixed(2);

// PAN for tag 5A with the middle digits replaced by F nibbles; odd length padded with F.
function maskedPanHex(pan) {
  const d = String(pan);
  const masked = d.slice(0, 6) + 'F'.repeat(Math.max(0, d.length - 10)) + d.slice(-4);
  return masked.length % 2 ? masked + 'F' : masked;
}

// "MM/YY" -> YYMMDD of the last day of that month (tag 5F24)
function expiryYYMMDD(exp) {
  const [mm, yy] = String(exp).split('/').map(Number);
  const last = new Date(Date.UTC(2000 + yy, mm, 0)).getUTCDate();
  return String(yy).padStart(2, '0') + String(mm).padStart(2, '0') + String(last).padStart(2, '0');
}

// ------------------------
// Recorder: steps + log lines + structured log entries (for the device log)
// ------------------------
function makeRecorder(now) {
  const steps = [];
  const log = [];
  const entries = [];
  let clock = now ? new Date(now.getTime()) : new Date();
  const stamp = () => {
    const p = (n, l = 2) => String(n).padStart(l, '0');
    const s = `${p(clock.getMonth() + 1)}-${p(clock.getDate())} ${p(clock.getHours())}:${p(clock.getMinutes())}:${p(clock.getSeconds())}.${p(clock.getMilliseconds(), 3)}`;
    clock = new Date(clock.getTime() + 37);
    return s;
  };
  const logLine = (level, tag, msg) => {
    const ts = stamp();
    log.push(`${ts} ${level} ${tag.padEnd(9)}: ${msg}`);
    entries.push({ ts, level, tag, msg });
  };
  const apdu = (name, capdu, rdata, sw, note) => {
    const swInfo = sw ? decodeSW(sw) : { sw: null, ok: false, meaning: 'No response from card' };
    const step = {
      seq: steps.length + 1, type: 'APDU', name, command: commandName(capdu), c_apdu: capdu,
      r_apdu: sw ? (rdata || '') + sw : null, sw: swInfo.sw, sw_meaning: swInfo.meaning
    };
    if (note) step.note = note;
    steps.push(step);
    logLine('D', 'EMVKernel', `>> C-APDU ${capdu}`);
    logLine(sw && swInfo.ok ? 'D' : 'E', 'EMVKernel', sw ? `<< R-APDU ${(rdata || '') + sw}  (${swInfo.meaning})` : '<< R-APDU NO RESPONSE (card removed / reader timeout)');
    return step;
  };
  const event = (type, name, detail, level = 'I', tag = 'EMVKernel') => {
    steps.push({ seq: steps.length + 1, type, name, ...detail });
    logLine(level, tag, `${name}${detail.note ? ' - ' + detail.note : ''}`);
  };
  return { steps, log, entries, logLine, apdu, event };
}

// Host leg shared by all interfaces. Returns { hostCode, received, applied }.
function hostLeg(rec, input, fault, { allowMalformed, extraCodeFault }) {
  let hostCode = input.host.responseCode;
  let received = true;
  let applied = false;
  if (fault === 'malformed_tlv' && allowMalformed) { applied = true; hostCode = '30'; }
  if (fault === 'issuer_91') { applied = true; hostCode = '91'; }
  if (fault === 'issuer_96') { applied = true; hostCode = '96'; }
  if (extraCodeFault) hostCode = extraCodeFault;
  if (fault === 'host_timeout') { applied = true; received = false; }

  rec.event('HOST', '0100 authorization request sent',
    { mti: '0100', note: fault === 'malformed_tlv' && allowMalformed ? 'DE55 truncated by the packer (2 bytes short)' : undefined }, 'I', 'HostLink');
  if (!received) {
    rec.event('HOST', 'No 0110 within 30 s', { note: 'Host timeout' }, 'E', 'HostLink');
    hostCode = null;
  } else {
    rec.event('HOST', `0110 received: DE39 ${hostCode}`, { mti: '0110', response_code: hostCode }, hostCode === '00' ? 'I' : 'W', 'HostLink');
  }
  return { hostCode, received, applied };
}

function terminated(rec, base, sdkError, reason, extra = {}) {
  rec.event('TERMINAL', `Transaction terminated: ${reason}`, { sdk_error: sdkError, note: 'Not accepted. No host message sent.' }, 'E');
  rec.logLine('W', 'EMVKernel', 'Transaction result: TERMINATED');
  return {
    ...base,
    steps: rec.steps, log: rec.log, log_entries: rec.entries,
    outcome: { status: 'TERMINATED', response_code: null, terminal_decision: 'TERMINATED', reversal_required: false, sdk_error: sdkError, reason },
    ...extra
  };
}

function finalOutcome(status, responseCode, reversalRequired, faultApplied, fault) {
  const sdkError = faultApplied ? FAULTS[fault].sdk_error : null;
  return { status, response_code: responseCode, terminal_decision: status, reversal_required: reversalRequired, sdk_error: sdkError };
}

// ------------------------
// Trace builder (dispatch)
// ------------------------
// input:
//   transactionId, scheme, aid, pan (full; only the masked form is written), exp ('MM/YY'),
//   amountMinor, currencyNumeric ('840'), country ('0840'), date (YYMMDD), un, stan,
//   cryptogram (the 0100's 9F26), expired (bool), host: { responseCode }, fault (name or null),
//   now (Date), entryMode (null | 'chip' | 'contactless' | 'swipe' | 'fallback'), config (terminal profile)
// returns { interface, chip_data, steps, log, log_entries, summary, outcome, fault_applied, fault_note, first_gen_ac }
function buildTrace(input) {
  const cfg = input.config || terminalConfig.get();
  const mode = input.entryMode || 'chip';
  if (mode === 'contactless') return buildContactlessTrace(input, cfg);
  if (mode === 'swipe' || mode === 'fallback') return buildMagstripeTrace(input, cfg, mode);
  return buildContactTrace(input, cfg);
}

// ------------------------
// Contact
// ------------------------
function buildContactTrace(input, cfg) {
  const rec = makeRecorder(input.now);
  const { apdu, event, logLine } = rec;
  const fault = input.fault || null;
  const base = { interface: 'contact', chip_data: true, fault_applied: false, fault_note: null, first_gen_ac: null };

  const label = LABELS[input.scheme] || 'CREDIT';
  const amount = bcd(input.amountMinor, 6);
  const tvr = [0, 0, 0, 0, 0];
  let tsi = 0;
  let cvmr = '3F0000';
  let faultApplied = false;
  let faultNote = null;

  logLine('I', 'EMVKernel', `Transaction start: contact, amount ${money(input.amountMinor)} (${input.currencyNumeric}), terminal AID ${input.aid}`);

  // 1. Application selection via PSE
  const pse = '315041592E5359532E4444463031';
  apdu('Select PSE', '00A404000E' + pse + '00',
    buildTLV('6F', buildTLV('84', pse) + buildTLV('A5', buildTLV('88', '01') + buildTLV('5F2D', ascii('en')))), '9000');
  apdu('Read PSE directory', '00B2010C00',
    buildTLV('70', buildTLV('61', buildTLV('4F', input.aid) + buildTLV('50', ascii(label)) + buildTLV('87', '01'))), '9000');

  if (!cfg.aids.includes(input.aid)) {
    const note = fault === 'app_not_found' ? 'The AID is not in the terminal profile, so SELECT was never sent and the app_not_found fault could not trigger.' : null;
    return terminated(rec, base, 'ERR_AID_NOT_SUPPORTED', `card AID ${input.aid} is not in the terminal profile`, { summary: summarize(tvr, tsi, cvmr, null, null), fault_note: note });
  }

  const aidLc = h(input.aid.length / 2, 1);
  if (fault === 'app_not_found') {
    faultApplied = true;
    apdu('Select application', '00A40400' + aidLc + input.aid + '00', '', '6A82',
      'Card has no application with this AID');
    event('TERMINAL', 'Candidate list empty: transaction terminated', { note: 'Not accepted. No host message sent.' }, 'E');
    const summary = summarize(tvr, tsi, cvmr, null, null);
    logLine('I', 'EMVKernel', `TVR=${summary.tvr} TSI=${summary.tsi} CVMR=${summary.cvm_results}`);
    return {
      ...base, steps: rec.steps, log: rec.log, log_entries: rec.entries, summary,
      outcome: { status: 'TERMINATED', response_code: null, terminal_decision: 'TERMINATED', reversal_required: false, sdk_error: FAULTS.app_not_found.sdk_error, reason: 'card has no application with the selected AID (6A82)' },
      fault_applied: true
    };
  }

  apdu('Select application', '00A40400' + aidLc + input.aid + '00',
    buildTLV('6F', buildTLV('84', input.aid) + buildTLV('A5', buildTLV('50', ascii(label)) + buildTLV('87', '01') + buildTLV('9F38', PDOL))), '9000');

  // 2. GET PROCESSING OPTIONS
  const pdolData = amount + bcd(input.currencyNumeric, 2) + input.date + '00' + input.un;
  apdu('Get processing options', '80A80000' + h(pdolData.length / 2 + 2, 1) + '83' + h(pdolData.length / 2, 1) + pdolData + '00',
    buildTLV('77', buildTLV('82', AIP) + buildTLV('94', AFL)), '9000');

  // 3. Read application data (AFL)
  const exp = expiryYYMMDD(input.exp);
  apdu('Read record', '00B2010C00',
    buildTLV('70', buildTLV('5A', maskedPanHex(input.pan)) + buildTLV('5F24', exp) + buildTLV('5F20', ascii('TEST/CARDHOLDER')) + buildTLV('5F34', '01')),
    '9000', 'PAN masked (F nibbles) in the log');
  apdu('Read record', '00B2011400',
    buildTLV('70', buildTLV('8C', CDOL1) + buildTLV('8D', CDOL2) + buildTLV('8E', CVM_LIST) + buildTLV('8F', CARD_CAPK)
      + buildTLV('9F07', 'FF00') + buildTLV('9F08', '0002') + buildTLV('5F25', '200101')
      + buildTLV('9F0D', 'B860248800') + buildTLV('9F0E', '0010000000') + buildTLV('9F0F', 'B860249800')), '9000');

  // 4. Offline data authentication (DDA). Needs the CA public key named by tag 8F.
  if (cfg.capk_indexes.includes(CARD_CAPK)) {
    apdu('Internal authenticate (DDA)', '0088000004' + input.un + '00', buildTLV('80', fakeHex('sdad' + input.transactionId, 16)), '9000',
      'Signed dynamic application data verified with CAPK index 09 (simulated)');
  } else {
    tvr[0] |= 0x08;
    event('TERMINAL', `ODA: CA public key index ${CARD_CAPK} not loaded on the terminal - DDA failed`,
      { note: `Terminal CAPKs: ${cfg.capk_indexes.join(', ') || 'none'}. Load the CAPK through TMS.` }, 'W');
  }
  tsi |= 0x80;

  // 5. Processing restrictions
  if (input.expired) {
    tvr[1] |= 0x40;
    event('TERMINAL', 'Processing restrictions: application expired', { note: `5F24 ${exp} is before 9A ${input.date}` }, 'W');
  }

  // 6. Cardholder verification (CVM list: 1F06 under 50.00, then 4103 offline PIN, then 1E03 signature)
  tsi |= 0x40;
  if (input.amountMinor < NO_CVM_LIMIT_MINOR) {
    cvmr = '1F0602';
    event('TERMINAL', 'CVM: No CVM required (amount under X = 50.00)', { cvm_results: cvmr });
    if (fault === 'pin_try_limit') faultNote = 'Amount is under the card\'s No-CVM limit (50.00), so no PIN was requested and the PIN fault could not trigger.';
  } else if (fault === 'pin_try_limit') {
    faultApplied = true;
    apdu('Get data: PIN try counter', '80CA9F1700', buildTLV('9F17', '00'), '9000', 'No PIN tries left');
    apdu('Verify offline PIN', '0020008008' + '24****FFFFFFFFFF', '', '6983', 'PIN block masked in the log');
    tvr[2] |= 0x80 | 0x20;
    cvmr = '410301';
    event('TERMINAL', 'CVM failed: PIN Try Limit exceeded', { cvm_results: cvmr }, 'W');
  } else {
    apdu('Get data: PIN try counter', '80CA9F1700', buildTLV('9F17', '03'), '9000');
    apdu('Verify offline PIN', '0020008008' + '24****FFFFFFFFFF', '', '9000', 'PIN block masked in the log');
    cvmr = '410302';
    event('TERMINAL', 'CVM: offline plaintext PIN verified', { cvm_results: cvmr });
  }

  // 7. Terminal risk management: online-only terminal
  tsi |= 0x08;
  if (input.amountMinor >= cfg.floor_limit_minor) {
    tvr[3] |= 0x80;
    event('TERMINAL', `Terminal risk management: floor limit ${money(cfg.floor_limit_minor)}, transaction goes online`, {});
  } else {
    event('TERMINAL', `Terminal risk management: amount under floor limit ${money(cfg.floor_limit_minor)}; online-only terminal, transaction goes online`, {});
  }

  // 8. Terminal action analysis -> 1st GENERATE AC (ARQC)
  const tvrHex = () => tvr.map((b) => h(b, 1)).join('');
  const cdol1Data = () => amount + '000000000000' + input.country + tvrHex() + bcd(input.currencyNumeric, 2) + input.date + '00' + input.un;
  const atc = atcFromStan(input.stan);
  const d1 = cdol1Data();
  apdu('1st Generate AC', '80AE8000' + h(d1.length / 2, 1) + d1 + '00',
    buildTLV('77', buildTLV('9F27', '80') + buildTLV('9F36', atc) + buildTLV('9F26', input.cryptogram) + buildTLV('9F10', IAD)), '9000');
  tsi |= 0x20;
  const cid1 = '80';
  // Snapshot sent in the 0100's DE55 (server.js -> setTerminalResults)
  const firstGenAc = { tvr: tvrHex(), tsi: h(tsi, 1) + '00', atc, cid: cid1 };
  logLine('I', 'EMVKernel', `ARQC received; TVR=${tvrHex()} CVMR=${cvmr}`);

  // 9. Online authorization
  const host = hostLeg(rec, input, fault, { allowMalformed: true, extraCodeFault: fault === 'pin_try_limit' && faultApplied ? '75' : null });
  faultApplied = faultApplied || host.applied;
  const { hostCode, received } = host;

  // 10. Issuer authentication (approvals only)
  const approved = hostCode === '00';
  let cardDeclinedAfterApproval = false;
  if (approved) {
    const arpc = fakeHex('arpc' + input.cryptogram + input.transactionId, 8);
    if (fault === 'issuer_auth_failed') {
      faultApplied = true;
      apdu('External authenticate', '008200000A' + arpc + ascii('00'), '', '6300', 'ARPC did not verify');
      tvr[4] |= 0x40;
      cardDeclinedAfterApproval = true;
    } else {
      apdu('External authenticate', '008200000A' + arpc + ascii('00'), '', '9000');
    }
    tsi |= 0x10;
  } else if (fault === 'issuer_auth_failed' || fault === 'card_removed') {
    faultNote = `Issuer did not approve (DE39 ${hostCode || 'none'}), so this post-approval fault could not trigger.`;
  }

  // 11. 2nd GENERATE AC
  const arc = received ? hostCode : 'Z3';
  const wantTC = approved && !cardDeclinedAfterApproval;
  const d2 = ascii(arc) + cdol1Data();
  const p1 = wantTC ? '40' : '00';
  let cid2 = null;
  let reversalRequired = false;
  let terminalDecision;

  if (approved && fault === 'card_removed') {
    faultApplied = true;
    apdu('2nd Generate AC', '80AE' + p1 + '00' + h(d2.length / 2, 1) + d2 + '00', null, null, 'Card removed before the final cryptogram');
    reversalRequired = true;
    terminalDecision = 'CARD_REMOVED_REVERSED';
  } else {
    cid2 = wantTC ? '40' : '00';
    apdu('2nd Generate AC', '80AE' + p1 + '00' + h(d2.length / 2, 1) + d2 + '00',
      buildTLV('77', buildTLV('9F27', cid2) + buildTLV('9F36', atc) + buildTLV('9F26', fakeHex('ac2' + input.transactionId, 8)) + buildTLV('9F10', IAD)), '9000');
    if (wantTC) terminalDecision = 'APPROVED';
    else if (cardDeclinedAfterApproval) { terminalDecision = 'DECLINED_BY_CARD'; reversalRequired = true; }
    else if (!received) { terminalDecision = 'TIMEOUT_REVERSED'; reversalRequired = true; }
    else terminalDecision = 'DECLINED';
  }

  if (reversalRequired) {
    const why = !received ? 'timeout reversal for the unanswered 0100'
      : cardDeclinedAfterApproval ? 'card declined after issuer approval' : 'no final cryptogram from the card';
    event('HOST', '0400 reversal sent', { mti: '0400', note: why }, 'W', 'HostLink');
  }

  const summary = summarize(tvr, tsi, cvmr, cid1, cid2);
  logLine('I', 'EMVKernel', `TVR=${summary.tvr} TSI=${summary.tsi} CVMR=${summary.cvm_results} CID=${cid2 || 'none'}`);
  logLine(terminalDecision === 'APPROVED' ? 'I' : 'W', 'EMVKernel', `Transaction result: ${terminalDecision}`);

  return {
    ...base, steps: rec.steps, log: rec.log, log_entries: rec.entries, summary,
    outcome: finalOutcome(terminalDecision, received ? hostCode : 'Z3', reversalRequired, faultApplied, fault),
    fault_applied: faultApplied,
    fault_note: faultNote,
    first_gen_ac: firstGenAc
  };
}

// ------------------------
// Contactless (Kernel C-2 / C-3 style: cryptogram in the GPO response, card leaves the field
// after the records are read, no EXTERNAL AUTHENTICATE / 2nd GENERATE AC)
// ------------------------
function buildContactlessTrace(input, cfg) {
  const rec = makeRecorder(input.now);
  const { apdu, event, logLine } = rec;
  const fault = input.fault || null;
  const kernel = KERNELS[input.scheme] || KERNELS.visa;
  const base = { interface: 'contactless', kernel: kernel.name, chip_data: true, fault_applied: false, fault_note: null, first_gen_ac: null };
  const label = LABELS[input.scheme] || 'CREDIT';
  const tvr = [0, 0, 0, 0, 0];
  const tsi = 0; // TSI is not used by the contactless kernels
  let cvmr = '3F0000';
  let faultApplied = false;
  let faultNote = null;
  const notApplicable = {
    pin_try_limit: 'Contactless uses online PIN or CDCVM; the offline PIN try counter is not involved, so the PIN fault could not trigger.',
    issuer_auth_failed: 'Contactless online authorisation has no EXTERNAL AUTHENTICATE / 2nd GENERATE AC, so issuer authentication cannot fail at the card.'
  };
  if (notApplicable[fault]) faultNote = notApplicable[fault];

  logLine('I', 'EMVKernel', `Transaction start: contactless, amount ${money(input.amountMinor)} (${input.currencyNumeric}), kernel ${kernel.name}`);

  // Pre-processing: contactless transaction limit
  const ctlsLimit = cfg.contactless_transaction_limit_minor;
  if (ctlsLimit > 0 && input.amountMinor > ctlsLimit) {
    const r = terminated(rec, { ...base, chip_data: false }, 'ERR_CTLS_LIMIT_EXCEEDED',
      `amount ${money(input.amountMinor)} is above the contactless transaction limit ${money(ctlsLimit)}; insert or swipe the card`,
      { summary: summarize(tvr, tsi, cvmr, null, null, { contactless: true }) });
    if (fault) r.fault_note = 'Contactless was refused before the card was read, so the fault could not trigger.';
    return r;
  }
  event('TERMINAL', 'Card detected in the field (tap)', {}, 'I', 'CardReader');

  // PPSE
  const ppse = '325041592E5359532E4444463031';
  apdu('Select PPSE', '00A404000E' + ppse + '00',
    buildTLV('6F', buildTLV('84', ppse) + buildTLV('A5', buildTLV('BF0C',
      buildTLV('61', buildTLV('4F', input.aid) + buildTLV('50', ascii(label)) + buildTLV('87', '01') + buildTLV('9F2A', kernel.id))))), '9000');

  if (!cfg.aids.includes(input.aid)) {
    const note = fault ? 'The AID is not in the terminal profile, so the transaction ended before the fault could trigger.' : null;
    return terminated(rec, base, 'ERR_AID_NOT_SUPPORTED', `card AID ${input.aid} is not in the terminal profile`,
      { summary: summarize(tvr, tsi, cvmr, null, null, { contactless: true }), fault_note: note });
  }

  const aidLc = h(input.aid.length / 2, 1);
  if (fault === 'app_not_found') {
    apdu('Select application', '00A40400' + aidLc + input.aid + '00', '', '6A82', 'Card has no application with this AID');
    const r = terminated(rec, base, FAULTS.app_not_found.sdk_error, 'card has no application with the selected AID (6A82)',
      { summary: summarize(tvr, tsi, cvmr, null, null, { contactless: true }) });
    r.fault_applied = true;
    return r;
  }
  apdu('Select application', '00A40400' + aidLc + input.aid + '00',
    buildTLV('6F', buildTLV('84', input.aid) + buildTLV('A5', buildTLV('50', ascii(label)) + buildTLV('87', '01') + buildTLV('9F38', CTLS_PDOL))), '9000');

  // Terminal risk (floor limit) before GPO, because TVR is in the PDOL
  if (input.amountMinor >= cfg.floor_limit_minor) tvr[3] |= 0x80;
  if (input.expired) tvr[1] |= 0x40;
  const overCvmLimit = input.amountMinor > cfg.contactless_cvm_limit_minor;
  if (overCvmLimit) tvr[2] |= 0x04; // online PIN entered (requested below)
  const tvrHex = () => tvr.map((b) => h(b, 1)).join('');

  // GPO with TTQ; the card answers with the ARQC (no separate GENERATE AC)
  const atc = atcFromStan(input.stan);
  const pdolData = TTQ + bcd(input.amountMinor, 6) + '000000000000' + input.country + tvrHex() + bcd(input.currencyNumeric, 2) + input.date + '00' + input.un;
  apdu('Get processing options', '80A80000' + h(pdolData.length / 2 + 2, 1) + '83' + h(pdolData.length / 2, 1) + pdolData + '00',
    buildTLV('77', buildTLV('82', AIP) + buildTLV('94', CTLS_AFL) + buildTLV('9F36', atc) + buildTLV('9F26', input.cryptogram)
      + buildTLV('9F10', IAD) + buildTLV('9F27', '80') + buildTLV('9F6C', '0000')), '9000', 'ARQC returned in the GPO response');

  // Read records; card_removed = card leaves the field here
  const exp = expiryYYMMDD(input.exp);
  if (fault === 'card_removed') {
    apdu('Read record', '00B2011C00', null, null, 'Card left the field before the records were read');
    const r = terminated(rec, base, FAULTS.card_removed.sdk_error, 'card removed too early; present the card again',
      { summary: summarize(tvr, tsi, cvmr, '80', null, { contactless: true }), first_gen_ac: { tvr: tvrHex(), tsi: '0000', atc, cid: '80' } });
    r.fault_applied = true;
    return r;
  }
  apdu('Read record', '00B2011C00',
    buildTLV('70', buildTLV('5A', maskedPanHex(input.pan)) + buildTLV('5F24', exp) + buildTLV('5F34', '01') + buildTLV('8F', CARD_CAPK)
      + buildTLV('9F4B', fakeHex('fdda' + input.transactionId, 16))), '9000', 'PAN masked (F nibbles) in the log');
  event('TERMINAL', 'Card read complete: card can be removed', {}, 'I', 'CardReader');

  // fDDA
  if (cfg.capk_indexes.includes(CARD_CAPK)) {
    event('TERMINAL', 'fDDA: signed dynamic data verified with CAPK index 09 (simulated)', {});
  } else {
    tvr[0] |= 0x08;
    event('TERMINAL', `fDDA: CA public key index ${CARD_CAPK} not loaded on the terminal - DDA failed`,
      { note: `Terminal CAPKs: ${cfg.capk_indexes.join(', ') || 'none'}. Load the CAPK through TMS.` }, 'W');
  }
  if (input.expired) event('TERMINAL', 'Processing restrictions: application expired', { note: `5F24 ${exp} is before 9A ${input.date}` }, 'W');

  // CVM by contactless CVM limit
  if (overCvmLimit) {
    cvmr = '420300';
    event('TERMINAL', `CVM: amount above contactless CVM limit ${money(cfg.contactless_cvm_limit_minor)} - online PIN entered`,
      { cvm_results: cvmr, note: 'PIN block encrypted for the host (not logged)' }, 'I', 'PinPad');
  } else {
    event('TERMINAL', `CVM: no CVM required (amount at or under contactless CVM limit ${money(cfg.contactless_cvm_limit_minor)})`, { cvm_results: cvmr });
  }
  const firstGenAc = { tvr: tvrHex(), tsi: '0000', atc, cid: '80' };
  logLine('I', 'EMVKernel', `ARQC received; TVR=${tvrHex()} CVMR=${cvmr}`);

  // Online
  const host = hostLeg(rec, input, fault, { allowMalformed: true, extraCodeFault: null });
  faultApplied = faultApplied || host.applied;
  const { hostCode, received } = host;
  let status;
  let reversalRequired = false;
  if (!received) { status = 'TIMEOUT_REVERSED'; reversalRequired = true; }
  else status = hostCode === '00' ? 'APPROVED' : 'DECLINED';
  if (reversalRequired) event('HOST', '0400 reversal sent', { mti: '0400', note: 'timeout reversal for the unanswered 0100' }, 'W', 'HostLink');
  event('TERMINAL', 'Online result applied; no 2nd GENERATE AC (card already removed)', {});

  const summary = summarize(tvr, tsi, cvmr, '80', null, { contactless: true });
  logLine('I', 'EMVKernel', `TVR=${summary.tvr} TSI=${summary.tsi} CVMR=${summary.cvm_results} CID=80`);
  logLine(status === 'APPROVED' ? 'I' : 'W', 'EMVKernel', `Transaction result: ${status}`);

  return {
    ...base, steps: rec.steps, log: rec.log, log_entries: rec.entries, summary,
    outcome: finalOutcome(status, received ? hostCode : 'Z3', reversalRequired, faultApplied, fault),
    fault_applied: faultApplied,
    fault_note: faultNote,
    first_gen_ac: firstGenAc
  };
}

// ------------------------
// Magnetic stripe: "swipe" (refused for chip cards) and "fallback" (chip failed, then swipe)
// ------------------------
function buildMagstripeTrace(input, cfg, mode) {
  const rec = makeRecorder(input.now);
  const { event, logLine } = rec;
  const fault = input.fault || null;
  const base = { interface: 'magstripe', chip_data: false, fault_applied: false, fault_note: null, first_gen_ac: null };
  const noChip = 'No chip data in a magnetic-stripe transaction, so this card-side fault could not trigger.';
  let faultNote = ['app_not_found', 'pin_try_limit', 'malformed_tlv', 'issuer_auth_failed', 'card_removed'].includes(fault) ? noChip : null;

  logLine('I', 'EMVKernel', `Transaction start: ${mode}, amount ${money(input.amountMinor)} (${input.currencyNumeric})`);

  if (mode === 'swipe') {
    event('TERMINAL', 'Card swiped: track 2 read, service code 201 (chip card)', {}, 'I', 'CardReader');
    const r = terminated(rec, base, 'ERR_CHIP_CARD_SWIPED', 'chip card swiped; insert the card', { summary: summarize(null) });
    r.fault_note = fault ? 'The swipe was refused before any host message, so the fault could not trigger.' : null;
    return r;
  }

  event('TERMINAL', 'Card inserted', {}, 'I', 'CardReader');
  for (let i = 1; i <= 3; i++) event('TERMINAL', `ICC power-on failed: no ATR (attempt ${i}/3)`, {}, 'E', 'CardReader');
  event('TERMINAL', 'Technical fallback to magnetic stripe: remove and swipe the card', {}, 'W', 'EMVKernel');
  event('TERMINAL', 'Card swiped: track 2 read, service code 201', { note: 'POS entry mode 801 (fallback)' }, 'I', 'CardReader');
  event('TERMINAL', 'CVM: signature', {}, 'I', 'EMVKernel');

  const host = hostLeg(rec, input, fault, { allowMalformed: false, extraCodeFault: null });
  const { hostCode, received } = host;
  let status;
  let reversalRequired = false;
  if (!received) { status = 'TIMEOUT_REVERSED'; reversalRequired = true; }
  else status = hostCode === '00' ? 'APPROVED' : 'DECLINED';
  if (reversalRequired) event('HOST', '0400 reversal sent', { mti: '0400', note: 'timeout reversal for the unanswered 0100' }, 'W', 'HostLink');
  logLine(status === 'APPROVED' ? 'I' : 'W', 'EMVKernel', `Transaction result: ${status}`);

  return {
    ...base, steps: rec.steps, log: rec.log, log_entries: rec.entries, summary: summarize(null),
    outcome: finalOutcome(status, received ? hostCode : 'Z3', reversalRequired, host.applied, fault),
    fault_applied: host.applied,
    fault_note: faultNote
  };
}

// tvr === null -> magnetic stripe (no EMV data)
function summarize(tvr, tsi, cvmr, cid1, cid2, { contactless = false } = {}) {
  if (tvr === null) {
    return { tvr: null, tsi: null, cvm_results: null, cid_first: null, cid_final: null, explained: null };
  }
  const tvrHex = tvr.map((b) => h(b, 1)).join('');
  const tsiHex = contactless ? '0000' : h(tsi, 1) + '00';
  return {
    tvr: tvrHex,
    tsi: tsiHex,
    cvm_results: cvmr,
    cid_first: cid1,
    cid_final: cid2,
    explained: {
      tvr: decodeTVR(tvrHex),
      tsi: decodeTSI(tsiHex),
      cvm_results: decodeCVMResults(cvmr),
      cid_first: cid1 ? decodeCID(cid1) : null,
      cid_final: cid2 ? decodeCID(cid2) : null
    }
  };
}

module.exports = { FAULTS, TERMINAL_ERRORS, listFaults, buildTrace, maskedPanHex, expiryYYMMDD, NO_CVM_LIMIT_MINOR, TTQ, KERNELS };
