#!/usr/bin/env node
// Adds the agent-status hooks to ~/.claude/settings.json (or removes them with --remove).
// Existing settings and hooks are kept; a backup is written first. Safe to run twice.
//   node install-claude-hooks.mjs [--remove] [--url http://127.0.0.1:7777] [--settings path]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const remove = args.includes('--remove');
const base = (opt('--url') ?? 'http://127.0.0.1:7777').replace(/\/$/, '');
const file = opt('--settings') ?? join(homedir(), '.claude', 'settings.json');
const MARKER = '/events/claude?pid=';

const command = `curl -s -m 1 -X POST -H "content-type: application/json" --data-binary @- "${base}${MARKER}$PPID" >/dev/null 2>&1 || true`;
const hook = { type: 'command', command, timeout: 3 };
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

let settings = {};
if (existsSync(file)) {
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Can't parse ${file}: ${err.message}. Fix it by hand, then run this again.`);
    process.exit(1);
  }
  copyFileSync(file, `${file}.bak-agent-status`);
}

const ours = h => typeof h?.command === 'string' && h.command.includes(MARKER);
settings.hooks ??= {};
for (const ev of EVENTS) {
  // Drop any previous copy of our hook (so a changed --url takes effect), keep everyone else's.
  const kept = (settings.hooks[ev] ?? [])
    .map(entry => ({ ...entry, hooks: (entry.hooks ?? []).filter(h => !ours(h)) }))
    .filter(entry => entry.hooks.length);
  if (!remove) kept.push(TOOL_EVENTS.has(ev) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] });
  if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(remove
  ? `Removed agent-status hooks from ${file}.`
  : `Installed agent-status hooks in ${file}, reporting to ${base}.`);
if (existsSync(`${file}.bak-agent-status`)) console.log(`Backup: ${file}.bak-agent-status`);
