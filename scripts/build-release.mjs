#!/usr/bin/env node
// Builds release/agent-status-<version>.tar.gz: everything needed to run the board
// and connect both agents, with no npm install. Only Node (>= 22) is required.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `agent-status-${version}`;
const out = join(root, 'release');
const stage = join(out, name);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });

// One plain-JS file, so it runs on any Node 22+ without type stripping or packages.
execFileSync(join(root, 'node_modules/.bin/esbuild'), [
  'src/server.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22',
  `--outfile=${join(stage, 'dist/server.mjs')}`, '--log-level=warning',
], { cwd: root, stdio: 'inherit' });

cpSync(join(root, 'public'), join(stage, 'public'), { recursive: true });
cpSync(join(root, 'integrations'), join(stage, 'integrations'), { recursive: true });
copyFileSync(join(root, 'scripts/install-claude-hooks.mjs'), join(stage, 'install-claude-hooks.mjs'));
copyFileSync(join(root, 'README.md'), join(stage, 'README.md'));
writeFileSync(join(stage, 'VERSION'), version + '\n');
writeFileSync(join(stage, 'start.sh'), '#!/bin/sh\nexec node "$(dirname "$0")/dist/server.mjs" "$@"\n');
chmodSync(join(stage, 'start.sh'), 0o755);
chmodSync(join(stage, 'install-claude-hooks.mjs'), 0o755);

const tarball = join(out, `${name}.tar.gz`);
// COPYFILE_DISABLE stops macOS tar adding ._ resource-fork files.
execFileSync('tar', ['-czf', tarball, '-C', out, name], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit' });
const sha = execFileSync('shasum', ['-a', '256', tarball], { encoding: 'utf8' }).split(' ')[0];
writeFileSync(`${tarball}.sha256`, `${sha}  ${name}.tar.gz\n`);
console.log(`${tarball}\nsha256 ${sha}`);
