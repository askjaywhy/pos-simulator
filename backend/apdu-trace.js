// apdu-trace.js
// Builds a contact EMV kernel trace (C-APDU / R-APDU with status words, host messages and
// terminal decisions) for a processed transaction, plus the opt-in fault catalogue.
//
// The trace is a simulation of the card <-> terminal dialogue around the existing host decision.
// It never changes the default authorization result: with no fault, the trace simply explains
// how the card and terminal got to the result the simulator already returns.
//
// PCI: the PAN in record data is masked with F nibbles (first 6 / last 4 kept) and PIN blocks
// are never logged in clear. Cryptograms, ARPCs and SDAD are deterministic placeholders.

const crypto = require('crypto');
const { buildTLV, CARD_AIP, atcFromStan } = require('./emv-iso8583');
const { decodeTVR, decodeTSI, decodeCVMResults, decodeCID, decodeSW, commandName } = require('./emv-decoder');

// ------------------------
// Fault catalogue
// ------------------------
// stage: where the fault bites. "card" faults change the card dialogue, "host" faults replace
// the host decision, "post_auth" faults only apply after an issuer approval (fault_applied=false otherwise).
const FAULTS = {
  app_not_found: {
    stage: 'card',
    description: 'SELECT of the terminal\'s AID returns 6A82: the card does not carry that AID, or the AID is missing from the terminal (TMS) profile. Transaction terminates before any host message.',
    expected: { status: 'TERMINATED', response_code: null }
  },
  pin_try_limit: {
    stage: 'card',
    description: 'Offline PIN is blocked: GET DATA 9F17 returns 00 and VERIFY returns 6983. TVR byte 3 flags the failure, the terminal still goes online, the issuer declines 75. Only applies above the card\'s No-CVM limit (50.00), because the CVM list waives CVM below it.',
    expected: { status: 'DECLINED', response_code: '75' }
  },
  malformed_tlv: {
    stage: 'host',
    description: 'The terminal\'s message packer truncates DE55 (last 2 bytes lost). The host cannot parse ICC data and rejects with 30 (format error); the card then returns an AAC. Compare emv.tlv_hex with iso8583.fields[55] to spot it.',
    expected: { status: 'DECLINED', response_code: '30' }
  },
  host_timeout: {
    stage: 'host',
    description: 'The 0100 is sent but no 0110 arrives within 30 s. The terminal completes with ARC Z3 (unable to go online), the card returns an AAC, and the terminal sends a timeout reversal (0400) for the unanswered request.',
    expected: { status: 'TIMEOUT_REVERSED', response_code: 'Z3' }
  },
  issuer_91: {
    stage: 'host',
    description: 'Host responds 91 (issuer or switch inoperative). Card returns an AAC at 2nd GENERATE AC.',
    expected: { status: 'DECLINED', response_code: '91' }
  },
  issuer_96: {
    stage: 'host',
    description: 'Host responds 96 (system malfunction). Card returns an AAC at 2nd GENERATE AC.',
    expected: { status: 'DECLINED', response_code: '96' }
  },
  issuer_auth_failed: {
    stage: 'post_auth',
    description: 'Issuer approves (00), but EXTERNAL AUTHENTICATE returns 6300 (ARPC did not verify). TVR byte 5 flags it, the card declines with an AAC at 2nd GENERATE AC, and the terminal must reverse the approved auth (0400). Only applies when the issuer approves.',
    expected: { status: 'DECLINED_BY_CARD', response_code: '00' }
  },
  card_removed: {
    stage: 'post_auth',
    description: 'Issuer approves (00), but the card is pulled before 2nd GENERATE AC, which gets no response. With no TC the terminal must reverse the approved auth (0400). Only applies when the issuer approves.',
    expected: { status: 'CARD_REMOVED_REVERSED', response_code: '00' }
  }
};

function listFaults() {
  return Object.entries(FAULTS).map(([name, f]) => ({ name, stage: f.stage, description: f.description, expected: f.expected }));
}

// ------------------------
// Card profile (per scheme)
// ------------------------
const NO_CVM_LIMIT_MINOR = 5000; // CVM list amount X: No CVM required under 50.00
const CVM_LIST = '00001388' + '00000000' + '1F06' + '4103' + '1E03'; // X=50.00, Y=0; No CVM <X, offline PIN, signature
const CDOL1 = '9F02069F03069F1A0295055F2A029A039C019F3704';
const CDOL2 = '8A02' + CDOL1;
const PDOL = '9F02065F2A029A039C019F3704';
const AIP = CARD_AIP; // DDA, cardholder verification, terminal risk management, issuer authentication supported
const AFL = '08010100' + '10010101'; // SFI 1 rec 1; SFI 2 rec 1 (used in ODA)
const IAD = '06010A03A00000';

const LABELS = { visa: 'VISA CREDIT', mastercard: 'MASTERCARD', amex: 'AMERICAN EXPRESS', discover: 'DISCOVER' };
const ascii = (s) => Buffer.from(s, 'ascii').toString('hex').toUpperCase();
const h = (n, bytes) => n.toString(16).toUpperCase().padStart(bytes * 2, '0');
const bcd = (digits, bytes) => String(digits).padStart(bytes * 2, '0').slice(-bytes * 2);
const fakeHex = (seed, bytes) => crypto.createHash('sha256').update(String(seed)).digest('hex').toUpperCase().slice(0, bytes * 2);

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
// Trace builder
// ------------------------
// input:
//   transactionId, scheme, aid, pan (full; only the masked form is written), exp ('MM/YY'),
//   amountMinor, currencyNumeric ('840'), country ('0840'), date (YYMMDD), time (HHMMSS),
//   un, stan, cryptogram (the 0100's 9F26), expired (bool), host: { responseCode, sent, received },
//   fault (name or null), now (Date)
// returns { steps, log, summary, outcome }
function buildTrace(input) {
  const steps = [];
  const log = [];
  const fault = input.fault || null;
  let clock = input.now ? new Date(input.now.getTime()) : new Date();
  const stamp = () => {
    const p = (n, l = 2) => String(n).padStart(l, '0');
    const s = `${p(clock.getMonth() + 1)}-${p(clock.getDate())} ${p(clock.getHours())}:${p(clock.getMinutes())}:${p(clock.getSeconds())}.${p(clock.getMilliseconds(), 3)}`;
    clock = new Date(clock.getTime() + 37);
    return s;
  };
  const logLine = (level, tag, msg) => log.push(`${stamp()} ${level} ${tag.padEnd(9)}: ${msg}`);

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

  const label = LABELS[input.scheme] || 'CREDIT';
  const amount = bcd(input.amountMinor, 6);
  const tvr = [0, 0, 0, 0, 0];
  let tsi = 0;
  let cvmr = '3F0000';
  let faultApplied = false;
  let faultNote = null;

  logLine('I', 'EMVKernel', `Transaction start: contact, amount ${(input.amountMinor / 100).toFixed(2)} (${input.currencyNumeric}), terminal AID ${input.aid}`);

  // 1. Application selection via PSE
  const pse = '315041592E5359532E4444463031';
  apdu('Select PSE', '00A404000E' + pse + '00',
    buildTLV('6F', buildTLV('84', pse) + buildTLV('A5', buildTLV('88', '01') + buildTLV('5F2D', ascii('en')))), '9000');
  apdu('Read PSE directory', '00B2010C00',
    buildTLV('70', buildTLV('61', buildTLV('4F', input.aid) + buildTLV('50', ascii(label)) + buildTLV('87', '01'))), '9000');

  const aidLc = h(input.aid.length / 2, 1);
  if (fault === 'app_not_found') {
    faultApplied = true;
    apdu('Select application', '00A40400' + aidLc + input.aid + '00', '', '6A82',
      'Card has no application with this AID, or the AID is not in the terminal profile');
    event('TERMINAL', 'Candidate list empty: transaction terminated', { note: 'Not accepted. No host message sent.' }, 'E');
    const summary = summarize(tvr, tsi, cvmr, null, null);
    logLine('I', 'EMVKernel', `TVR=${summary.tvr} TSI=${summary.tsi} CVMR=${summary.cvm_results}`);
    return { steps, log, summary, outcome: { status: 'TERMINATED', response_code: null, terminal_decision: 'TERMINATED', reversal_required: false }, fault_applied: true, fault_note: null };
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
    buildTLV('70', buildTLV('8C', CDOL1) + buildTLV('8D', CDOL2) + buildTLV('8E', CVM_LIST) + buildTLV('8F', '09')
      + buildTLV('9F07', 'FF00') + buildTLV('9F08', '0002') + buildTLV('5F25', '200101')
      + buildTLV('9F0D', 'B860248800') + buildTLV('9F0E', '0010000000') + buildTLV('9F0F', 'B860249800')), '9000');

  // 4. Offline data authentication (DDA)
  apdu('Internal authenticate (DDA)', '0088000004' + input.un + '00', buildTLV('80', fakeHex('sdad' + input.transactionId, 16)), '9000',
    'Signed dynamic application data verified with CAPK index 09 (simulated)');
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

  // 7. Terminal risk management: online-only terminal, floor limit 0
  tvr[3] |= 0x80;
  tsi |= 0x08;
  event('TERMINAL', 'Terminal risk management: floor limit 0, transaction goes online', {});

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
  let hostCode = input.host.responseCode;
  let received = true;
  if (fault === 'malformed_tlv') { faultApplied = true; hostCode = '30'; }
  if (fault === 'issuer_91') { faultApplied = true; hostCode = '91'; }
  if (fault === 'issuer_96') { faultApplied = true; hostCode = '96'; }
  if (fault === 'pin_try_limit' && faultApplied) hostCode = '75';
  if (fault === 'host_timeout') { faultApplied = true; received = false; }

  event('HOST', '0100 authorization request sent', { mti: '0100', note: fault === 'malformed_tlv' ? 'DE55 truncated by the packer (2 bytes short)' : undefined }, 'I', 'HostLink');
  if (!received) {
    event('HOST', 'No 0110 within 30 s', { note: 'Host timeout' }, 'E', 'HostLink');
    hostCode = null;
  } else {
    event('HOST', `0110 received: DE39 ${hostCode}`, { mti: '0110', response_code: hostCode }, hostCode === '00' ? 'I' : 'W', 'HostLink');
  }

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
    steps, log, summary,
    outcome: { status: terminalDecision, response_code: received ? hostCode : 'Z3', terminal_decision: terminalDecision, reversal_required: reversalRequired },
    fault_applied: faultApplied,
    fault_note: faultNote,
    first_gen_ac: firstGenAc
  };
}

function summarize(tvr, tsi, cvmr, cid1, cid2) {
  const tvrHex = tvr.map((b) => h(b, 1)).join('');
  const tsiHex = h(tsi, 1) + '00';
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

module.exports = { FAULTS, listFaults, buildTrace, maskedPanHex, expiryYYMMDD, NO_CVM_LIMIT_MINOR };
