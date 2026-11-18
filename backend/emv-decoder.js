// emv-decoder.js
// Support-engineer decoders: TVR (95), TSI (9B), CVM Results (9F34), CID (9F27), APDU status
// words, a strict BER-TLV parser with error offsets, a DE55 mandatory-tag check, and an APDU
// log parser for logcat-style text. Pure functions, no I/O; used by server.js and tools/emv-decode.js.
//
// Bit meanings follow EMV Book 3 (Annex C) and Book 4. Scheme specs vary in places; where they
// do, the text says "commonly".

// ------------------------
// Tag names (decoder only; the simulator's EMV_TAGS dictionary is untouched)
// ------------------------
const TAG_NAMES = {
  '4F': 'Application Identifier (AID) - card', '50': 'Application Label', '57': 'Track 2 Equivalent Data',
  '5A': 'Application PAN', '5F20': 'Cardholder Name', '5F24': 'Application Expiration Date',
  '5F25': 'Application Effective Date', '5F2A': 'Transaction Currency Code', '5F2D': 'Language Preference',
  '5F34': 'PAN Sequence Number', '61': 'Application Template', '6F': 'FCI Template', '70': 'Record Template',
  '71': 'Issuer Script Template 1', '72': 'Issuer Script Template 2', '77': 'Response Message Template Format 2',
  '80': 'Response Message Template Format 1', '82': 'Application Interchange Profile (AIP)',
  '84': 'Dedicated File (DF) Name', '87': 'Application Priority Indicator', '88': 'Short File Identifier (SFI)',
  '8A': 'Authorisation Response Code', '8C': 'CDOL1', '8D': 'CDOL2', '8E': 'CVM List',
  '8F': 'CA Public Key Index', '91': 'Issuer Authentication Data', '94': 'Application File Locator (AFL)',
  '95': 'Terminal Verification Results (TVR)', '9A': 'Transaction Date', '9B': 'Transaction Status Information (TSI)',
  '9C': 'Transaction Type', '9F02': 'Amount, Authorised', '9F03': 'Amount, Other',
  '9F06': 'Application Identifier (AID) - terminal', '9F07': 'Application Usage Control',
  '9F08': 'Application Version Number (card)', '9F09': 'Application Version Number (terminal)',
  '9F0D': 'Issuer Action Code - Default', '9F0E': 'Issuer Action Code - Denial', '9F0F': 'Issuer Action Code - Online',
  '9F10': 'Issuer Application Data (IAD)', '9F11': 'Issuer Code Table Index', '9F17': 'PIN Try Counter',
  '9F1A': 'Terminal Country Code', '9F1E': 'IFD Serial Number', '9F21': 'Transaction Time',
  '9F26': 'Application Cryptogram', '9F27': 'Cryptogram Information Data (CID)', '9F33': 'Terminal Capabilities',
  '9F34': 'CVM Results', '9F35': 'Terminal Type', '9F36': 'Application Transaction Counter (ATC)',
  '9F37': 'Unpredictable Number', '9F38': 'PDOL', '9F39': 'POS Entry Mode', '9F2A': 'Kernel Identifier',
  '9F6C': 'Card Transaction Qualifiers (CTQ)', 'BF0C': 'FCI Issuer Discretionary Data', '9F4B': 'Signed Dynamic Application Data', '9F66': 'Terminal Transaction Qualifiers (TTQ)',
  'A5': 'FCI Proprietary Template'
};

const tagName = (tag) => TAG_NAMES[tag] || 'Unknown tag';

// ------------------------
// Bit tables
// ------------------------
const TVR_BITS = [
  // byte 1
  ['Offline data authentication was not performed', 'SDA failed', 'ICC data missing',
    'Card appears on terminal exception file', 'DDA failed', 'CDA failed', 'SDA selected', null],
  // byte 2
  ['ICC and terminal have different application versions', 'Expired application', 'Application not yet effective',
    'Requested service not allowed for card product', 'New card', null, null, null],
  // byte 3
  ['Cardholder verification was not successful', 'Unrecognised CVM', 'PIN Try Limit exceeded',
    'PIN entry required and PIN pad not present or not working', 'PIN entry required, PIN pad present, but PIN was not entered',
    'Online PIN entered', null, null],
  // byte 4
  ['Transaction exceeds floor limit', 'Lower consecutive offline limit exceeded', 'Upper consecutive offline limit exceeded',
    'Transaction selected randomly for online processing', 'Merchant forced transaction online', null, null, null],
  // byte 5
  ['Default TDOL used', 'Issuer authentication failed', 'Script processing failed before final GENERATE AC',
    'Script processing failed after final GENERATE AC', null, null, null, null]
];

const TSI_BITS = [
  ['Offline data authentication was performed', 'Cardholder verification was performed', 'Card risk management was performed',
    'Issuer authentication was performed', 'Terminal risk management was performed', 'Script processing was performed', null, null],
  [null, null, null, null, null, null, null, null]
];

// What a support engineer usually checks next when a TVR bit is set.
const TVR_HINTS = {
  'Offline data authentication was not performed': 'AIP has no SDA/DDA/CDA bit, or the terminal skipped ODA. Check AIP (82) and terminal capabilities (9F33).',
  'ICC data missing': 'A mandatory card tag was not read. Check the AFL (94) records and READ RECORD status words.',
  'DDA failed': 'Commonly a missing or expired CA public key: check the CAPK index (8F) against the terminal\'s CAPK set from TMS.',
  'CDA failed': 'Commonly a missing or expired CA public key: check the CAPK index (8F) against the terminal\'s CAPK set from TMS.',
  'SDA failed': 'Commonly a missing or expired CA public key: check the CAPK index (8F) against the terminal\'s CAPK set from TMS.',
  'ICC and terminal have different application versions': 'Compare 9F08 (card) with 9F09 (terminal AID config).',
  'Expired application': '5F24 is in the past relative to 9A. Card is expired; host will normally decline 54.',
  'Application not yet effective': '5F25 is after 9A. Check the terminal date/time.',
  'Cardholder verification was not successful': 'See CVM Results (9F34) and any VERIFY status words.',
  'PIN Try Limit exceeded': 'PIN Try Counter (9F17) is 00 or VERIFY returned 6983. Cardholder must reset the PIN with the issuer.',
  'Transaction exceeds floor limit': 'Normal for online-only terminals (floor limit 0): forces the transaction online.',
  'Issuer authentication failed': 'EXTERNAL AUTHENTICATE returned 6300, or the ARPC in 91 did not verify. Card will usually decline at 2nd GENERATE AC, so the auth must be reversed.'
};

function hexToBytes(hex, expectedLen, label) {
  const clean = String(hex || '').replace(/\s/g, '').toUpperCase();
  if (!/^[0-9A-F]*$/.test(clean) || clean.length % 2 !== 0) throw new Error(`${label}: not valid hex`);
  if (expectedLen && clean.length !== expectedLen * 2) throw new Error(`${label}: expected ${expectedLen} bytes, got ${clean.length / 2}`);
  return { clean, bytes: clean.match(/../g).map((b) => parseInt(b, 16)) };
}

function decodeBits(table, bytes) {
  const set = [];
  bytes.forEach((byte, bi) => {
    for (let bit = 0; bit < 8; bit++) {
      if (byte & (0x80 >> bit)) {
        const meaning = table[bi] ? table[bi][bit] : null;
        set.push({ byte: bi + 1, bit: 8 - bit, meaning: meaning || 'RFU (should be 0)' });
      }
    }
  });
  return set;
}

function decodeTVR(hex) {
  const { clean, bytes } = hexToBytes(hex, 5, 'TVR');
  const set = decodeBits(TVR_BITS, bytes).map((b) => ({ ...b, hint: TVR_HINTS[b.meaning] || null }));
  return { tag: '95', value: clean, clean: set.length === 0, set };
}

function decodeTSI(hex) {
  const { clean, bytes } = hexToBytes(hex, 2, 'TSI');
  return { tag: '9B', value: clean, set: decodeBits(TSI_BITS, bytes) };
}

const CVM_METHODS = {
  0x00: 'Fail CVM processing', 0x01: 'Plaintext PIN verified by ICC', 0x02: 'Enciphered PIN verified online',
  0x03: 'Plaintext PIN by ICC and signature', 0x04: 'Enciphered PIN verified by ICC',
  0x05: 'Enciphered PIN by ICC and signature', 0x1E: 'Signature (paper)', 0x1F: 'No CVM required',
  0x3F: 'No CVM performed'
};
const CVM_CONDITIONS = {
  0x00: 'Always', 0x01: 'If unattended cash', 0x02: 'If not unattended cash, not manual cash, not purchase with cashback',
  0x03: 'If terminal supports the CVM', 0x04: 'If manual cash', 0x05: 'If purchase with cashback',
  0x06: 'If transaction is in the application currency and under X', 0x07: 'If transaction is in the application currency and over X',
  0x08: 'If transaction is in the application currency and under Y', 0x09: 'If transaction is in the application currency and over Y'
};
const CVM_RESULTS = { 0x00: 'Unknown (e.g. signature)', 0x01: 'Failed', 0x02: 'Successful' };

function cvmMethodName(b) {
  return CVM_METHODS[b & 0x3F] || `Issuer/payment-system specific (0x${(b & 0x3F).toString(16).toUpperCase()})`;
}

function decodeCVMResults(hex) {
  const { clean, bytes } = hexToBytes(hex, 3, 'CVM Results');
  return {
    tag: '9F34',
    value: clean,
    method: cvmMethodName(bytes[0]),
    apply_next_if_fails: Boolean(bytes[0] & 0x40),
    condition: CVM_CONDITIONS[bytes[1]] || `Unknown condition (0x${clean.slice(2, 4)})`,
    result: CVM_RESULTS[bytes[2]] || `Unknown (0x${clean.slice(4, 6)})`
  };
}

// 8E: amount X (4) + amount Y (4) + 2-byte rules
function decodeCVMList(hex) {
  const { clean, bytes } = hexToBytes(hex, null, 'CVM List');
  if (bytes.length < 8 || (bytes.length - 8) % 2 !== 0) throw new Error('CVM List: must be 8 bytes of amounts plus 2-byte rules');
  const amt = (i) => parseInt(clean.slice(i * 2, i * 2 + 8), 16);
  const rules = [];
  for (let i = 8; i < bytes.length; i += 2) {
    rules.push({
      rule: clean.slice(i * 2, i * 2 + 4),
      method: cvmMethodName(bytes[i]),
      apply_next_if_fails: Boolean(bytes[i] & 0x40),
      condition: CVM_CONDITIONS[bytes[i + 1]] || `Unknown condition (0x${clean.slice(i * 2 + 2, i * 2 + 4)})`
    });
  }
  return { tag: '8E', value: clean, amount_x_minor: amt(0), amount_y_minor: amt(4), rules };
}

const CID_TYPES = { 0: 'AAC (declined)', 1: 'TC (approved offline)', 2: 'ARQC (go online)', 3: 'RFU' };
const CID_REASONS = { 0: 'No information given', 1: 'Service not allowed', 2: 'PIN Try Limit exceeded', 3: 'Issuer authentication failed' };

function decodeCID(hex) {
  const { clean, bytes } = hexToBytes(hex, 1, 'CID');
  const b = bytes[0];
  return {
    tag: '9F27',
    value: clean,
    cryptogram: CID_TYPES[(b >> 6) & 0x03],
    advice_required: Boolean(b & 0x08),
    reason: CID_REASONS[b & 0x07] || 'RFU'
  };
}

// GENERATE AC P1 reference control parameter
function decodeGenAcP1(p1) {
  const types = { 0x00: 'AAC', 0x40: 'TC', 0x80: 'ARQC' };
  return { requested: types[p1 & 0xC0] || 'RFU', cda_requested: Boolean(p1 & 0x10) };
}

// ------------------------
// Status words
// ------------------------
const SW_TABLE = {
  '9000': 'Success',
  '6283': 'Selected file invalidated (application blocked)',
  '6300': 'Authentication failed (e.g. EXTERNAL AUTHENTICATE: ARPC did not verify)',
  '6700': 'Wrong length (Lc)',
  '6981': 'Command incompatible with file structure',
  '6983': 'Authentication method blocked (PIN Try Limit exceeded)',
  '6984': 'Referenced data invalidated',
  '6985': 'Conditions of use not satisfied (e.g. GENERATE AC out of sequence)',
  '6A81': 'Function not supported (card or application blocked)',
  '6A82': 'File or application not found',
  '6A83': 'Record not found (check the AFL)',
  '6A86': 'Incorrect parameters P1-P2',
  '6A88': 'Referenced data not found (GET DATA tag not on card)',
  '6D00': 'Instruction code not supported',
  '6E00': 'Class not supported',
  '6F00': 'No precise diagnosis (often card removed or comms error)'
};

function decodeSW(sw) {
  const s = String(sw || '').replace(/\s/g, '').toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(s)) return { sw: s, ok: false, meaning: 'Not a status word (expected 4 hex characters)' };
  if (SW_TABLE[s]) return { sw: s, ok: s === '9000', meaning: SW_TABLE[s] };
  if (s.startsWith('61')) return { sw: s, ok: true, meaning: `${parseInt(s.slice(2), 16)} more response bytes available (GET RESPONSE)` };
  if (s.startsWith('6C')) return { sw: s, ok: false, meaning: `Wrong Le; resend with Le=${s.slice(2)}` };
  if (s.startsWith('63C')) return { sw: s, ok: false, meaning: `Verification failed; ${parseInt(s[3], 16)} tries remaining` };
  return { sw: s, ok: false, meaning: 'Unlisted error status' };
}

// ------------------------
// APDU command names
// ------------------------
function commandName(capduHex) {
  const h = String(capduHex || '').toUpperCase();
  const cla = h.slice(0, 2);
  const ins = h.slice(2, 4);
  const map = {
    A4: 'SELECT', B2: 'READ RECORD', A8: 'GET PROCESSING OPTIONS', AE: 'GENERATE AC', '88': 'INTERNAL AUTHENTICATE',
    '82': 'EXTERNAL AUTHENTICATE', '20': 'VERIFY', CA: 'GET DATA', C0: 'GET RESPONSE', '24': 'CHANGE PIN', '18': 'APPLICATION UNBLOCK'
  };
  const name = map[ins] || `INS ${ins}`;
  if (ins === 'AE' && h.length >= 6) return `${name} (${decodeGenAcP1(parseInt(h.slice(4, 6), 16)).requested} requested)`;
  if (ins === 'B2' && h.length >= 8) {
    const p2 = parseInt(h.slice(6, 8), 16);
    return `${name} SFI ${p2 >> 3} record ${parseInt(h.slice(4, 6), 16)}`;
  }
  return cla === '80' || cla === '00' || cla === '84' ? name : `${name} (CLA ${cla})`;
}

// ------------------------
// Strict BER-TLV parser
// ------------------------
// Returns { ok, items: [{ tag, name, offset, length, value, children? }], errors: [{ offset, tag?, message }] }.
// Offsets are byte offsets into the input. Stops at the first structural error, because nothing after it can be trusted.
function parseTLV(hex, { recurse = true, baseOffset = 0 } = {}) {
  const clean = String(hex || '').replace(/\s/g, '').toUpperCase();
  const items = [];
  const errors = [];
  if (!/^[0-9A-F]*$/.test(clean) || clean.length % 2 !== 0) {
    return { ok: false, items, errors: [{ offset: 0, message: 'Not valid hex (odd length or non-hex characters)' }] };
  }
  const bytes = clean.match(/../g) || [];
  let i = 0;
  while (i < bytes.length) {
    const start = i;
    // Padding between objects (00 or FF) is allowed by ISO 7816-4
    if (bytes[i] === '00' || bytes[i] === 'FF') { i++; continue; }
    let tag = bytes[i++];
    if ((parseInt(tag, 16) & 0x1F) === 0x1F) {
      do {
        if (i >= bytes.length) { errors.push({ offset: baseOffset + start, message: `Tag starting ${tag} is cut off` }); return { ok: false, items, errors }; }
        tag += bytes[i++];
      } while (parseInt(tag.slice(-2), 16) & 0x80);
    }
    if (i >= bytes.length) { errors.push({ offset: baseOffset + start, tag, message: `Tag ${tag} has no length byte` }); break; }
    let len = parseInt(bytes[i++], 16);
    if (len & 0x80) {
      const n = len & 0x7F;
      if (n === 0 || n > 3 || i + n > bytes.length) {
        errors.push({ offset: baseOffset + start, tag, message: `Tag ${tag} has an invalid long-form length (0x${bytes[i - 1]})` });
        break;
      }
      len = parseInt(bytes.slice(i, i + n).join(''), 16);
      i += n;
    }
    const remaining = bytes.length - i;
    if (len > remaining) {
      errors.push({
        offset: baseOffset + start, tag,
        message: `Tag ${tag} (${tagName(tag)}) declares ${len} bytes but only ${remaining} remain: data is truncated or a length byte is wrong`
      });
      break;
    }
    const value = bytes.slice(i, i + len).join('');
    const item = { tag, name: tagName(tag), offset: baseOffset + start, length: len, value };
    const constructed = Boolean(parseInt(tag.slice(0, 2), 16) & 0x20);
    if (recurse && constructed && len > 0) {
      const inner = parseTLV(value, { recurse, baseOffset: baseOffset + i });
      item.children = inner.items;
      errors.push(...inner.errors);
    }
    items.push(item);
    i += len;
  }
  return { ok: errors.length === 0, items, errors };
}

// Flatten nested items to { tag: value } (first occurrence wins)
function flattenTLV(items, out = {}) {
  for (const it of items) {
    if (!(it.tag in out)) out[it.tag] = it.value;
    if (it.children) flattenTLV(it.children, out);
  }
  return out;
}

// Tags commonly required in DE55 for an online (ARQC) authorization. Scheme specs vary
// (e.g. some require 84/4F, 9F33, 9F34, 9F35); this is the common core.
const DE55_REQUIRED = ['82', '95', '9A', '9C', '5F2A', '9F02', '9F03', '9F10', '9F1A', '9F26', '9F27', '9F36', '9F37'];

function checkDE55(hex) {
  const parsed = parseTLV(hex);
  const flat = flattenTLV(parsed.items);
  const missing = DE55_REQUIRED.filter((t) => !(t in flat)).map((t) => ({ tag: t, name: tagName(t) }));
  return { ok: parsed.ok && missing.length === 0, parse_errors: parsed.errors, missing_required: missing, present: Object.keys(flat) };
}

// Decode a TLV blob and explain the well-known tags inside it.
function explainTLV(hex) {
  const parsed = parseTLV(hex);
  const flat = flattenTLV(parsed.items);
  const explained = {};
  const safe = (fn, v) => { try { return fn(v); } catch (e) { return { error: e.message }; } };
  if (flat['95']) explained['95'] = safe(decodeTVR, flat['95']);
  if (flat['9B']) explained['9B'] = safe(decodeTSI, flat['9B']);
  if (flat['9F34']) explained['9F34'] = safe(decodeCVMResults, flat['9F34']);
  if (flat['9F27']) explained['9F27'] = safe(decodeCID, flat['9F27']);
  if (flat['8E']) explained['8E'] = safe(decodeCVMList, flat['8E']);
  if (flat['8A']) explained['8A'] = { tag: '8A', value: flat['8A'], ascii: Buffer.from(flat['8A'], 'hex').toString('latin1') };
  return { ...parsed, explained };
}

// ------------------------
// APDU log parser
// ------------------------
// Accepts logcat-style or plain text. Recognized lines contain "C-APDU <hex>" / ">> <hex>" for
// commands and "R-APDU <hex>" / "<< <hex>" for responses (data + SW1SW2). Anything else is ignored
// except "TVR=", "TSI=", "CVMR=", "CID=" key/value pairs, which are decoded too.
function parseApduLog(text) {
  const lines = String(text || '').split(/\r?\n/);
  const exchanges = [];
  const findings = [];
  const kv = {};
  let pending = null;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    // Hex may be split into byte groups ("90 00") and followed by free text ("(Success)").
    // '*' is allowed in commands because masked PIN blocks are logged that way.
    const c = line.match(/(?:C-APDU|>>)(?:\s*C-APDU)?\s*:?\s*([0-9A-Fa-f*]{8,}(?:\s[0-9A-Fa-f*]{2,})*)(?![0-9A-Za-z])/);
    const rm = line.match(/(?:R-APDU|<<)(?:\s*R-APDU)?\s*:?\s*(NO RESPONSE.*|[0-9A-Fa-f]{2,}(?:\s[0-9A-Fa-f]{2,})*)(?![0-9A-Za-z])/);
    const r = rm && (/^NO RESPONSE/i.test(rm[1]) || rm[1].replace(/\s/g, '').length >= 4) ? rm : null;
    for (const m of line.matchAll(/\b(TVR|TSI|CVMR|CID)=([0-9A-Fa-f]+)/g)) kv[m[1]] = { value: m[2].toUpperCase(), line: lineNo };

    if (c) {
      if (pending) {
        pending.sw_meaning = 'No response logged before the next command';
        findings.push({ line: pending.line, severity: 'error', message: `${pending.command}: no response logged before the next command` });
        exchanges.push(pending);
      }
      const capdu = c[1].replace(/\s/g, '').toUpperCase();
      pending = { line: lineNo, command: commandName(capdu), c_apdu: capdu, r_apdu: null, sw: null };
    } else if (r) {
      const raw = r[1].trim();
      const ex = pending || { line: lineNo, command: 'UNKNOWN (no command logged)', c_apdu: null };
      if (/^NO RESPONSE/i.test(raw)) {
        ex.r_apdu = null;
        ex.sw = null;
        ex.sw_meaning = 'No response from card';
        findings.push({ line: lineNo, severity: 'error', message: `${ex.command}: no response from card (removed, or reader timeout)` });
      } else {
        const rapdu = raw.replace(/\s/g, '').toUpperCase();
        ex.r_apdu = rapdu;
        ex.data = rapdu.slice(0, -4);
        const sw = decodeSW(rapdu.slice(-4));
        ex.sw = sw.sw;
        ex.sw_meaning = sw.meaning;
        if (!sw.ok) findings.push({ line: lineNo, severity: 'error', message: `${ex.command}: SW ${sw.sw} = ${sw.meaning}` });
        if (ex.data) {
          const t = explainTLV(ex.data);
          if (Object.keys(t.explained).length) ex.explained = t.explained;
          if (!t.ok) findings.push({ line: lineNo, severity: 'warning', message: `${ex.command}: response TLV error: ${t.errors[0].message}` });
          if (t.explained['9F27'] && !t.explained['9F27'].error) {
            findings.push({ line: lineNo, severity: 'info', message: `${ex.command}: card returned ${t.explained['9F27'].cryptogram}` });
          }
        }
      }
      exchanges.push(ex);
      pending = null;
    }
  });
  if (pending) {
    pending.sw_meaning = 'Command logged with no response line after it';
    findings.push({ line: pending.line, severity: 'error', message: `${pending.command}: no response logged (card removed or log cut off)` });
    exchanges.push(pending);
  }

  const safe = (fn, v) => { try { return fn(v); } catch (e) { return { error: e.message }; } };
  const decodedKv = {};
  if (kv.TVR) {
    decodedKv.TVR = { line: kv.TVR.line, ...safe(decodeTVR, kv.TVR.value) };
    (decodedKv.TVR.set || []).forEach((b) => findings.push({ line: kv.TVR.line, severity: 'info', message: `TVR byte ${b.byte} bit ${b.bit}: ${b.meaning}` }));
  }
  if (kv.TSI) decodedKv.TSI = { line: kv.TSI.line, ...safe(decodeTSI, kv.TSI.value) };
  if (kv.CVMR) decodedKv.CVMR = { line: kv.CVMR.line, ...safe(decodeCVMResults, kv.CVMR.value) };
  if (kv.CID) decodedKv.CID = { line: kv.CID.line, ...safe(decodeCID, kv.CID.value) };

  return { exchanges, findings, values: decodedKv };
}

module.exports = {
  TAG_NAMES, tagName, decodeTVR, decodeTSI, decodeCVMResults, decodeCVMList, decodeCID, decodeGenAcP1,
  decodeSW, commandName, parseTLV, flattenTLV, explainTLV, checkDE55, DE55_REQUIRED, parseApduLog
};
