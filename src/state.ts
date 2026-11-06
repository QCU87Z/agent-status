import { basename } from 'node:path';

export type Agent = 'claude' | 'opencode';

export type State = 'working' | 'waiting_prompt' | 'waiting_permission' | 'error' | 'ended' | 'stale';

// Normalised event names. Claude hooks are mapped onto these by fromClaudeHook;
// the OpenCode plugin sends them directly.
export type EventName = 'start' | 'prompt' | 'tool' | 'tool_done' | 'permission' | 'idle' | 'error' | 'end' | 'heartbeat' | 'title';

export interface AgentEvent {
  agent: Agent;
  sessionId: string;
  event: EventName;
  cwd?: string;
  pid?: number;
  title?: string;
  tool?: string;
  detail?: string;
}

export interface Session {
  key: string;
  agent: Agent;
  sessionId: string;
  project: string;
  cwd: string;
  title: string;
  state: State;
  stateSince: number;
  detail: string;
  lastTool: string;
  pid: number | null;
  startedAt: number;
  lastEventAt: number;
  lastSeenAt: number;
}

const EVENTS: EventName[] = ['start', 'prompt', 'tool', 'tool_done', 'permission', 'idle', 'error', 'end', 'heartbeat', 'title'];

export function parseEvent(body: unknown): AgentEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.agent !== 'claude' && b.agent !== 'opencode') return null;
  if (typeof b.sessionId !== 'string' || !b.sessionId) return null;
  if (!EVENTS.includes(b.event as EventName)) return null;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const pid = Number(b.pid);
  return {
    agent: b.agent,
    sessionId: b.sessionId,
    event: b.event as EventName,
    cwd: str(b.cwd),
    pid: Number.isInteger(pid) && pid > 1 ? pid : undefined,
    title: str(b.title)?.slice(0, 200),
    tool: str(b.tool)?.slice(0, 200),
    detail: str(b.detail)?.slice(0, 500),
  };
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Maps a Claude Code hook payload (the JSON a hook receives on stdin) onto a normalised event.
export function fromClaudeHook(h: Record<string, unknown>, pid?: number): AgentEvent | null {
  const sessionId = typeof h.session_id === 'string' ? h.session_id : '';
  if (!sessionId) return null;
  const base = { agent: 'claude' as const, sessionId, cwd: typeof h.cwd === 'string' ? h.cwd : undefined, pid };
  const tool = typeof h.tool_name === 'string' ? h.tool_name : undefined;
  const message = typeof h.message === 'string' ? h.message : '';
  switch (h.hook_event_name) {
    case 'SessionStart':
      return { ...base, event: 'start' };
    case 'UserPromptSubmit':
      return { ...base, event: 'prompt', title: typeof h.prompt === 'string' ? oneLine(h.prompt, 120) : undefined };
    case 'PreToolUse':
      return { ...base, event: 'tool', tool, detail: describeClaudeTool(tool, h.tool_input) };
    case 'PostToolUse':
      return { ...base, event: 'tool_done', tool };
    case 'PermissionRequest':
      return { ...base, event: 'permission', tool, detail: describeClaudeTool(tool, h.tool_input) };
    case 'Notification': {
      // notification_type is newer; older versions only send the message text.
      const type = h.notification_type;
      if (type === 'permission_prompt' || (!type && /permission/i.test(message))) return { ...base, event: 'permission', detail: message };
      if (type === 'idle_prompt' || (!type && /waiting for your input/i.test(message))) return { ...base, event: 'idle' };
      return { ...base, event: 'heartbeat' };
    }
    case 'Stop':
      return { ...base, event: 'idle' };
    case 'SessionEnd':
      return { ...base, event: 'end', detail: typeof h.reason === 'string' ? `Session ended (${h.reason}).` : undefined };
    default:
      return { ...base, event: 'heartbeat' };
  }
}

function describeClaudeTool(tool: string | undefined, input: unknown): string | undefined {
  if (!tool || !input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const arg = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description;
  return typeof arg === 'string' ? oneLine(arg, 160) : undefined;
}

const NEXT: Partial<Record<EventName, State>> = {
  start: 'waiting_prompt',
  prompt: 'working',
  tool: 'working',
  tool_done: 'working',
  permission: 'waiting_permission',
  idle: 'waiting_prompt',
  error: 'error',
  end: 'ended',
};

export function reduce(prev: Session | undefined, e: AgentEvent, now: number): Session {
  const key = `${e.agent}:${e.sessionId}`;
  const s: Session = prev ? { ...prev } : {
    key, agent: e.agent, sessionId: e.sessionId,
    project: '', cwd: '', title: '', state: 'waiting_prompt', stateSince: now,
    detail: '', lastTool: '', pid: null, startedAt: now, lastEventAt: now, lastSeenAt: now,
  };
  if (e.cwd) { s.cwd = e.cwd; s.project = basename(e.cwd) || e.cwd; }
  if (e.pid) s.pid = e.pid;
  // Claude's title is its first prompt; OpenCode sends its real (possibly renamed) title.
  if (e.title && (e.agent === 'opencode' || !s.title)) s.title = e.title;
  s.lastSeenAt = now;

  if (e.event === 'heartbeat' || e.event === 'title') {
    // A stale session that reports in is alive after all; it was last seen working.
    if (s.state === 'stale') setState(s, 'working', now);
    return s;
  }
  // An ended session only comes back if the agent explicitly resumes it.
  if (s.state === 'ended' && e.event !== 'start' && e.event !== 'prompt') return s;

  s.lastEventAt = now;
  setState(s, NEXT[e.event]!, now);

  if (e.tool && (e.event === 'tool' || e.event === 'permission')) s.lastTool = e.tool;
  s.detail = detailFor(e, s);
  return s;
}

function setState(s: Session, state: State, now: number) {
  if (s.state !== state) { s.state = state; s.stateSince = now; }
}

function detailFor(e: AgentEvent, s: Session): string {
  if (e.detail) return e.detail;
  switch (e.event) {
    case 'start': return 'Started, no prompt yet.';
    case 'prompt': return 'Thinking…';
    case 'tool_done': return s.lastTool ? `Finished ${s.lastTool}, thinking…` : 'Thinking…';
    case 'tool': return '';
    case 'permission': return s.lastTool ? `Wants to use ${s.lastTool}` : 'Waiting for permission.';
    case 'idle': return 'Finished turn. Waiting for your next prompt.';
    case 'error': return 'The session reported an error.';
    case 'end': return 'Session ended.';
    default: return s.detail;
  }
}

export const STALE_AFTER = 10 * 60_000;
export const FORGET_AFTER = 60 * 60_000;

// Returns sessions to update and keys to remove. isAlive(pid) is injected for tests.
export function sweep(sessions: Iterable<Session>, now: number, isAlive: (pid: number) => boolean) {
  const changed: Session[] = [];
  const removed: string[] = [];
  for (const s of sessions) {
    if (s.state === 'ended') {
      if (now - s.stateSince > FORGET_AFTER) removed.push(s.key);
      continue;
    }
    if (s.pid && !isAlive(s.pid)) {
      changed.push({ ...s, state: 'ended', stateSince: now, detail: `Process gone (PID ${s.pid} not found).` });
    } else if (!s.pid && s.state === 'working' && now - s.lastSeenAt > STALE_AFTER) {
      changed.push({ ...s, state: 'stale', stateSince: now, detail: 'No events for 10 minutes and no process to check.' });
    }
  }
  return { changed, removed };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
