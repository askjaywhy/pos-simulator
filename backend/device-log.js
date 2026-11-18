// device-log.js
// Renders a transaction's APDU trace as an Android logcat "threadtime" log, the way a terminal
// SDK would write it: MM-DD HH:MM:SS.mmm  PID  TID L Tag: message
// Tags: SystemInfo, TermConfig, CardReader, EmvKernel, PinPad, Comm.
// APDU lines keep the "C-APDU <hex>" / "R-APDU <hex>" form and the summary keeps TVR=/TSI=/CVMR=/CID=,
// so the output round-trips through tools/emv-decode.js log and POST /api/tools/emv-decode {log}.

const PID = 4321;
const TIDS = { SystemInfo: 4321, TermConfig: 4321, CardReader: 4372, PinPad: 4375, EmvKernel: 4377, Comm: 4380 };

function deviceTag(entry) {
  if (entry.tag === 'HostLink') return 'Comm';
  if (entry.tag === 'CardReader' || entry.tag === 'PinPad') return entry.tag;
  const isApdu = /C-APDU|R-APDU/.test(entry.msg);
  if (!isApdu && /\bPIN\b/.test(entry.msg)) return 'PinPad';
  return 'EmvKernel';
}

const line = (ts, level, tag, msg) => `${ts}  ${PID}  ${TIDS[tag] || PID} ${level} ${tag}: ${msg}`;

// stored: the stored trace object (server.js storedTrace); returns an array of lines
function formatDeviceLog(transactionId, stored) {
  const entries = stored.log_entries || [];
  const first = entries[0] ? entries[0].ts : '01-01 00:00:00.000';
  const last = entries.length ? entries[entries.length - 1].ts : first;
  const t = stored.terminal || {};
  const k = t.kernel_versions || {};
  const out = ['--------- beginning of main'];
  out.push(line(first, 'I', 'SystemInfo', `serial=${t.serial_number || '-'} firmware=${t.firmware_version || '-'} kernel.contact="${k.contact || '-'}" kernel.contactless="${k.contactless || '-'}"`));
  out.push(line(first, 'I', 'TermConfig', `TID=${t.terminal_id || '-'} MID=${t.merchant_id || '-'} country=${t.country_code || '-'} type=${t.terminal_type || '-'} floor=${t.floor_limit_minor} ctlsCvmLimit=${t.contactless_cvm_limit_minor} ctlsTxnLimit=${t.contactless_transaction_limit_minor} capk=${(t.capk_indexes || []).join(',')} aids=${(t.aids || []).join(',')}`));
  out.push(line(first, 'I', 'EmvKernel', `txn=${transactionId} entry_mode=${stored.entry_mode || 'chip (default)'} interface=${stored.interface}${stored.kernel ? ' kernel=' + stored.kernel : ''}${stored.fault ? ' fault=' + stored.fault.name : ''}`));
  if (stored.interface === 'contact') out.push(line(first, 'I', 'CardReader', 'Card inserted'));
  for (const e of entries) out.push(line(e.ts, e.level, deviceTag(e), e.msg));
  if (stored.interface === 'contact' && !(stored.fault && stored.fault.name === 'card_removed' && stored.fault.applied)) {
    out.push(line(last, 'I', 'CardReader', 'Card removed'));
  }
  if (stored.outcome && stored.outcome.sdk_error) out.push(line(last, 'E', 'EmvKernel', `SDK error ${stored.outcome.sdk_error}`));
  return out;
}

module.exports = { formatDeviceLog };
