#!/usr/bin/env node
// emv-decode.js - support-engineer CLI for EMV data and APDU logs. No dependencies (Node 18+).
//
// Usage (from the repo root):
//   node tools/emv-decode.js tvr 0000008000
//   node tools/emv-decode.js tsi F800
//   node tools/emv-decode.js cvm 410301            (CVM Results, 9F34)
//   node tools/emv-decode.js cvmlist 0000138800000000 1F0641031E03
//   node tools/emv-decode.js cid 80
//   node tools/emv-decode.js sw 6A82
//   node tools/emv-decode.js tlv 771E9F2701809F3602...
//   node tools/emv-decode.js de55 9F0607A0000000031010...   (required-tag check for an online auth)
//   node tools/emv-decode.js log path/to/logcat.txt          (C-APDU/R-APDU lines, TVR=/TSI=/CVMR=/CID=)
//   node tools/emv-decode.js trace <transaction_id> [--api http://localhost:3001/api] [--save file.log]
//   add --json to any command for raw JSON output

const fs = require('fs');
const path = require('path');
const d = require(path.join(__dirname, '..', 'backend', 'emv-decoder.js'));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const json = args.includes('--json');
if (json) args.splice(args.indexOf('--json'), 1);
const api = flag('--api') || process.env.POS_API || 'http://localhost:3001/api';
const save = flag('--save');
const [cmd, ...rest] = args;
const arg = rest.join('');

const out = (obj, pretty) => console.log(json ? JSON.stringify(obj, null, 2) : pretty(obj));

function bitsText(r) {
  if (r.error) return `  error: ${r.error}`;
  if (!r.set.length) return `  ${r.value}: no bits set`;
  return r.set.map((b) => `  byte ${b.byte} bit ${b.bit}: ${b.meaning}${b.hint ? `\n      -> ${b.hint}` : ''}`).join('\n');
}
const cvmText = (c) => (c.error ? `  error: ${c.error}` : `  ${c.value}: ${c.method} | condition: ${c.condition} | result: ${c.result}`);
const cidText = (c) => (c.error ? `  error: ${c.error}` : `  ${c.value}: ${c.cryptogram} | reason: ${c.reason}${c.advice_required ? ' | advice required' : ''}`);

function tlvText(items, depth = 0) {
  return items.map((it) => {
    const pad = '  '.repeat(depth + 1);
    const line = `${pad}${it.tag.padEnd(4)} ${it.name} (${it.length})${it.children ? '' : ': ' + it.value}`;
    return it.children ? `${line}\n${tlvText(it.children, depth + 1)}` : line;
  }).join('\n');
}

function explainedText(ex) {
  const parts = [];
  if (ex['95']) parts.push(`TVR\n${bitsText(ex['95'])}`);
  if (ex['9B']) parts.push(`TSI\n${bitsText(ex['9B'])}`);
  if (ex['9F34']) parts.push(`CVM Results\n${cvmText(ex['9F34'])}`);
  if (ex['9F27']) parts.push(`CID\n${cidText(ex['9F27'])}`);
  if (ex['8E']) parts.push(`CVM List\n${ex['8E'].error ? '  error: ' + ex['8E'].error : ex['8E'].rules.map((r) => `  ${r.rule}: ${r.method} | ${r.condition}`).join('\n')}`);
  if (ex['8A']) parts.push(`ARC 8A: "${ex['8A'].ascii}"`);
  return parts.join('\n');
}

function logText(r) {
  const lines = r.exchanges.map((e) => `  L${String(e.line).padStart(4)}  ${e.command.padEnd(40)} ${e.sw || '----'}  ${e.sw_meaning || ''}`);
  const findings = r.findings.map((f) => `  L${String(f.line).padStart(4)}  [${f.severity.toUpperCase()}] ${f.message}`);
  const vals = Object.entries(r.values).map(([k, v]) => `${k}\n${k === 'TVR' || k === 'TSI' ? bitsText(v) : k === 'CVMR' ? cvmText(v) : cidText(v)}`);
  return ['APDU exchanges', ...lines, '', 'Findings', ...(findings.length ? findings : ['  none']), '', ...vals].join('\n');
}

async function main() {
  try {
    switch (cmd) {
      case 'tvr': return out(d.decodeTVR(arg), (r) => `TVR ${r.value}\n${bitsText(r)}`);
      case 'tsi': return out(d.decodeTSI(arg), (r) => `TSI ${r.value}\n${bitsText(r)}`);
      case 'cvm': return out(d.decodeCVMResults(arg), (r) => `CVM Results\n${cvmText(r)}`);
      case 'cvmlist': return out(d.decodeCVMList(arg), (r) => `CVM List  X=${(r.amount_x_minor / 100).toFixed(2)}  Y=${(r.amount_y_minor / 100).toFixed(2)}\n`
        + r.rules.map((x) => `  ${x.rule}: ${x.method} | ${x.condition}${x.apply_next_if_fails ? ' | apply next if this fails' : ''}`).join('\n'));
      case 'cid': return out(d.decodeCID(arg), (r) => `CID\n${cidText(r)}`);
      case 'sw': return out(d.decodeSW(arg), (r) => `SW ${r.sw}: ${r.meaning}`);
      case 'tlv': return out(d.explainTLV(arg), (r) => [tlvText(r.items),
        r.errors.length ? '\nErrors\n' + r.errors.map((e) => `  offset ${e.offset}: ${e.message}`).join('\n') : '',
        Object.keys(r.explained).length ? '\n' + explainedText(r.explained) : ''].join(''));
      case 'de55': return out(d.checkDE55(arg), (r) => [
        r.ok ? 'DE55 OK: parses cleanly, all commonly required tags present' : 'DE55 problems',
        ...r.parse_errors.map((e) => `  parse error at offset ${e.offset}: ${e.message}`),
        ...r.missing_required.map((m) => `  missing ${m.tag} ${m.name}`),
        `  present: ${r.present.join(' ')}`].join('\n'));
      case 'log': {
        if (!rest[0]) throw new Error('log: give a file path');
        return out(d.parseApduLog(fs.readFileSync(rest[0], 'utf8')), logText);
      }
      case 'trace': {
        if (!rest[0]) throw new Error('trace: give a transaction id');
        const res = await fetch(`${api}/transactions/${rest[0]}/apdu-trace`);
        const t = await res.json();
        if (!res.ok) throw new Error(t.error || `HTTP ${res.status}`);
        if (save) fs.writeFileSync(save, t.log.join('\n') + '\n');
        return out(t, (x) => [
          `Transaction ${x.transaction_id}  ${x.scheme.toUpperCase()}  AID ${x.aid}  fault: ${x.fault ? `${x.fault.name} (${x.fault.applied ? 'applied' : 'not applied'})` : 'none'}`,
          x.fault && x.fault.note ? `  note: ${x.fault.note}` : null,
          `Outcome: ${x.outcome.status}  DE39 ${x.outcome.response_code || '-'}${x.outcome.reversal_required ? '  (terminal reversal 0400 sent)' : ''}`,
          '', ...x.log, '',
          `TVR ${x.summary.tvr}\n${bitsText(x.summary.explained.tvr)}`,
          `TSI ${x.summary.tsi}\n${bitsText(x.summary.explained.tsi)}`,
          `CVM Results\n${cvmText(x.summary.explained.cvm_results)}`,
          x.summary.explained.cid_final ? `Final CID\n${cidText(x.summary.explained.cid_final)}` : 'Final CID: none (no final cryptogram)',
          x.de55_check ? `\nDE55 check (0100 as sent)\n${[...x.de55_check.parse_errors.map((e) => `  parse error at offset ${e.offset}: ${e.message}`),
            ...x.de55_check.missing_required.map((m) => `  missing ${m.tag} ${m.name}`)].join('\n') || '  OK'}` : '\nDE55 check: no 0100 was sent',
          save ? `\nLog saved to ${save}` : null
        ].filter((l) => l !== null).join('\n'));
      }
      default:
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
