#!/usr/bin/env node
// PostToolUse logger: every edit to a UI page object is appended to heal-log/heals.jsonl.
// The audit trail comes from the harness, not from the agent's self-report.
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const event = JSON.parse(raw || '{}');
  const inp = event.tool_input || {};
  if (!inp.file_path) return;
  const root = process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();
  const rel = path.relative(root, path.resolve(root, inp.file_path)).replace(/\\/g, '/');
  if (!rel.toLowerCase().startsWith('tests/ui/pages/')) return;

  const edits = inp.edits || [{ old_string: inp.old_string, new_string: inp.new_string }];
  const entry = {
    ts: new Date().toISOString(),
    session: event.session_id || null,
    tool: event.tool_name,
    file: rel,
    changes: event.tool_name === 'Write' ? 'full write'
      : edits.map((e) => ({ old: e.old_string, new: e.new_string })),
  };
  fs.mkdirSync(path.join(root, 'heal-log'), { recursive: true });
  fs.appendFileSync(path.join(root, 'heal-log', 'heals.jsonl'), JSON.stringify(entry) + '\n');
});
