import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromClaudeHook, parseEvent, pidAlive, reduce, sweep, type AgentEvent, type Session } from './state.ts';

const PORT = Number(process.env.PORT ?? 7777);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), '.agent-status');
const STATE_FILE = join(DATA_DIR, 'state.json');
const PAGE = new URL('../public/index.html', import.meta.url);
// Claude's PostToolUse payload includes the full tool output, which can be large.
const MAX_BODY = 32 * 1024 * 1024;

const sessions = new Map<string, Session>();
const clients = new Set<ServerResponse>();

function load() {
  try {
    const list = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Session[];
    for (const s of list) sessions.set(s.key, s);
  } catch {
    // No saved state yet, or it's unreadable: start empty.
  }
}

let saveTimer: NodeJS.Timeout | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify([...sessions.values()]));
    renameSync(tmp, STATE_FILE);
  }, 500);
}

function broadcast(type: 'session' | 'remove', data: unknown) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

function put(s: Session) {
  sessions.set(s.key, s);
  broadcast('session', s);
  save();
}

// A Claude hook runs under a shell, so $PPID may be that shell rather than Claude.
// Walk up a few parents to find the claude process; fall back to the pid we were given.
function resolveClaudePid(pid: number): number {
  let cur = pid;
  for (let i = 0; i < 4 && cur > 1; i++) {
    try {
      const [ppid, ...comm] = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(cur)], { encoding: 'utf8' }).trim().split(/\s+/);
      if (/claude/i.test(comm.join(' '))) return cur;
      cur = Number(ppid);
    } catch {
      break;
    }
  }
  return pid;
}

function apply(e: AgentEvent) {
  const key = `${e.agent}:${e.sessionId}`;
  const prev = sessions.get(key);
  if (e.agent === 'claude' && e.pid && !prev?.pid) e = { ...e, pid: resolveClaudePid(e.pid) };
  if (e.agent === 'claude' && prev?.pid) e = { ...e, pid: prev.pid };
  put(reduce(prev, e, Date.now()));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new Error('too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/events') {
      const e = parseEvent(await readBody(req));
      if (!e) return send(res, 400, { error: 'Expected { agent, sessionId, event }' });
      apply(e);
      return send(res, 204);
    }
    if (req.method === 'POST' && url.pathname === '/events/claude') {
      const body = await readBody(req);
      const pid = Number(url.searchParams.get('pid'));
      const e = body && typeof body === 'object' ? fromClaudeHook(body as Record<string, unknown>, pid > 1 ? pid : undefined) : null;
      if (!e) return send(res, 400, { error: 'Expected a Claude Code hook payload with session_id' });
      apply(e);
      return send(res, 204);
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return send(res, 200, [...sessions.values()]);
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      if (sessions.delete(key)) { broadcast('remove', key); save(); }
      return send(res, 204);
    }
    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify([...sessions.values()])}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(readFileSync(PAGE));
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const msg = (err as Error).message;
    send(res, msg === 'too large' ? 413 : 400, { error: msg });
  }
});

load();

setInterval(() => {
  const { changed, removed } = sweep(sessions.values(), Date.now(), pidAlive);
  for (const s of changed) put(s);
  for (const key of removed) { sessions.delete(key); broadcast('remove', key); save(); }
  // Comment line keeps idle SSE connections from being closed by proxies or the browser.
  for (const c of clients) c.write(': ping\n\n');
}, 10_000);

server.listen(PORT, HOST, () => {
  console.log(`Agent status board on http://${HOST}:${PORT} (state in ${STATE_FILE})`);
});
