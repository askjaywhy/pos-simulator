#!/usr/bin/env node
// PreToolUse guard for the POS simulator. Exit 2 = block (stderr goes back to the agent).
// 1) Agents may only write under tests/ and specs/ -- never the Express backend, the
//    terminal UI, or the EMV / ISO 8583 classes. A failing test must not be "fixed" by
//    changing the simulator.
// 2) In spec files, existing expect() lines may not be changed or removed, and
//    skip/fixme/retries/timeouts may not be introduced.
const fs = require('fs');
const path = require('path');

const ASSERT = /expect(\.soft)?\s*\(/;
const BANNED = /\btest\.(skip|fixme)\b|\.skip\(|retries\s*:|waitForTimeout\(|setTimeout\(/;
const WRITABLE = [/^tests\//, /^specs\//, /^heal-log\//];

function block(msg) {
  process.stderr.write(
    `BLOCKED by guard: ${msg}\n` +
    'Expected results (response codes, amounts, ISO fields) are the spec. If the simulator ' +
    'no longer matches them, report a suspected defect instead of editing tests or source.\n');
  process.exit(2);
}

const assertLines = (t) => (t || '').split(/\r?\n/).filter((l) => ASSERT.test(l)).map((l) => l.trim());

function main(event) {
  const tool = event.tool_name || '';
  const inp = event.tool_input || {};
  if (!inp.file_path) return;

  const root = process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();
  const abs = path.resolve(root, inp.file_path);
  const rel = path.relative(root, abs).replace(/\\/g, '/');

  if (rel.startsWith('..') || !WRITABLE.some((re) => re.test(rel.toLowerCase()))) {
    block(`agents may only write under tests/ or specs/ (attempted: ${rel}).`);
  }
  if (!/\.spec\.(ts|js)$/i.test(rel)) return;

  if (tool === 'Write') {
    const next = inp.content || '';
    if (!fs.existsSync(abs)) {
      if (BANNED.test(next)) block('new spec contains skip/fixme/retries/timeouts.');
      return; // brand-new spec file is allowed
    }
    const prev = fs.readFileSync(abs, 'utf8');
    const kept = new Set(assertLines(next));
    const missing = assertLines(prev).filter((a) => !kept.has(a));
    if (missing.length) block(`overwrite changes/removes ${missing.length} assertion(s), e.g. ${missing[0]}`);
    if (BANNED.test(next) && !BANNED.test(prev)) block('overwrite introduces skip/fixme/retries/timeouts.');
    return;
  }

  const edits = inp.edits || [{ old_string: inp.old_string, new_string: inp.new_string }];
  for (const e of edits) {
    const kept = new Set(assertLines(e.new_string));
    const removed = assertLines(e.old_string).filter((a) => !kept.has(a));
    if (removed.length) block(`edit changes/removes assertion: ${removed[0]}`);
    if (BANNED.test(e.new_string || '') && !BANNED.test(e.old_string || '')) {
      block('edit introduces skip/fixme/retries/timeouts.');
    }
  }
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => { main(JSON.parse(raw || '{}')); process.exit(0); });
