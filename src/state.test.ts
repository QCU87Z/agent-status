import { describe, expect, it } from 'vitest';
import { FORGET_AFTER, STALE_AFTER, fromClaudeHook, parseEvent, reduce, sweep, type AgentEvent, type Session } from './state.ts';

function run(events: (AgentEvent | null)[], start = 1_000) {
  let s: Session | undefined;
  const states: string[] = [];
  events.forEach((e, i) => {
    s = reduce(s, e!, start + i * 1000);
    states.push(s.state);
  });
  return { s: s!, states };
}

const claude = (h: Record<string, unknown>) => fromClaudeHook({ session_id: 'abc', cwd: '/Users/me/dev/proj', ...h }, 4242);

describe('Claude hook mapping', () => {
  it('walks a full turn with a permission prompt', () => {
    const { s, states } = run([
      claude({ hook_event_name: 'SessionStart', source: 'startup' }),
      claude({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the\nflaky test   in api.test.ts' }),
      claude({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
      claude({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
      claude({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
      claude({ hook_event_name: 'Stop' }),
      claude({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }),
      claude({ hook_event_name: 'SessionEnd', reason: 'exit' }),
    ]);
    expect(states).toEqual(['waiting_prompt', 'working', 'working', 'waiting_permission', 'working', 'waiting_prompt', 'waiting_prompt', 'ended']);
    expect(s.title).toBe('Fix the flaky test in api.test.ts');
    expect(s.project).toBe('proj');
    expect(s.pid).toBe(4242);
    expect(s.lastTool).toBe('Bash');
  });

  it('keeps the wait timer running when idle_prompt repeats a waiting state', () => {
    let s = reduce(undefined, claude({ hook_event_name: 'Stop' })!, 1000);
    s = reduce(s, claude({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })!, 61_000);
    expect(s.stateSince).toBe(1000);
  });

  it('falls back to the message text for older Notification payloads', () => {
    expect(claude({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Edit' })?.event).toBe('permission');
    expect(claude({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' })?.event).toBe('idle');
  });

  it('keeps the first prompt as the title', () => {
    const { s } = run([
      claude({ hook_event_name: 'UserPromptSubmit', prompt: 'first' }),
      claude({ hook_event_name: 'UserPromptSubmit', prompt: 'second' }),
    ]);
    expect(s.title).toBe('first');
  });

  it('describes the tool call', () => {
    const { s } = run([claude({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x/y.ts' } })]);
    expect(s.detail).toBe('/x/y.ts');
  });

  it('rejects payloads without a session id', () => {
    expect(fromClaudeHook({ hook_event_name: 'Stop' })).toBeNull();
  });
});

describe('OpenCode events', () => {
  const oc = (event: AgentEvent['event'], extra: Partial<AgentEvent> = {}) => parseEvent({ agent: 'opencode', sessionId: 'ses_1', event, pid: 99, cwd: '/w/homelab', ...extra });

  it('follows the plugin event sequence', () => {
    const { s, states } = run([
      oc('start', { title: 'New session' }),
      oc('prompt'),
      oc('tool', { tool: 'edit', detail: 'traefik.yml' }),
      oc('permission', { tool: 'edit', detail: 'Edit traefik.yml' }),
      oc('tool_done'),
      oc('title', { title: 'Rotate Traefik certs' }),
      oc('idle'),
      oc('heartbeat'),
    ]);
    expect(states).toEqual(['waiting_prompt', 'working', 'working', 'waiting_permission', 'working', 'working', 'waiting_prompt', 'waiting_prompt']);
    expect(s.title).toBe('Rotate Traefik certs');
  });

  it('heartbeats refresh lastSeenAt without moving the state timer', () => {
    let s = reduce(undefined, oc('idle')!, 1000);
    s = reduce(s, oc('heartbeat')!, 20_000);
    expect(s.lastSeenAt).toBe(20_000);
    expect(s.stateSince).toBe(1000);
  });

  it('ignores late events for an ended session, but a new prompt revives it', () => {
    const { states } = run([oc('end'), oc('idle'), oc('prompt')]);
    expect(states).toEqual(['ended', 'ended', 'working']);
  });

  it('validates input', () => {
    expect(parseEvent({ agent: 'other', sessionId: 'x', event: 'idle' })).toBeNull();
    expect(parseEvent({ agent: 'opencode', sessionId: 'x', event: 'explode' })).toBeNull();
    expect(parseEvent({ agent: 'opencode', sessionId: 'x', event: 'idle', pid: 'nope' })?.pid).toBeUndefined();
  });
});

describe('sweep', () => {
  const base = (over: Partial<Session>): Session => ({
    key: 'k', agent: 'claude', sessionId: 's', project: 'p', cwd: '/p', title: '', state: 'working', stateSince: 0,
    detail: '', lastTool: '', pid: null, startedAt: 0, lastEventAt: 0, lastSeenAt: 0, ...over,
  });

  it('ends sessions whose process is gone', () => {
    const { changed } = sweep([base({ pid: 10 }), base({ key: 'b', pid: 11 })], 5000, pid => pid === 11);
    expect(changed.map(s => [s.key, s.state])).toEqual([['k', 'ended']]);
  });

  it('marks silent pid-less working sessions stale', () => {
    const now = STALE_AFTER + 1;
    const { changed } = sweep([base({}), base({ key: 'w', state: 'waiting_prompt' })], now, () => true);
    expect(changed.map(s => [s.key, s.state])).toEqual([['k', 'stale']]);
  });

  it('forgets sessions an hour after they end', () => {
    const { removed } = sweep([base({ state: 'ended', stateSince: 0 }), base({ key: 'new', state: 'ended', stateSince: 10 })], FORGET_AFTER + 5, () => true);
    expect(removed).toEqual(['k']);
  });

  it('a stale session comes back to working when it reports in', () => {
    const s = reduce(base({ state: 'stale', key: 'claude:s', sessionId: 's' }), { agent: 'claude', sessionId: 's', event: 'heartbeat' }, 100);
    expect(s.state).toBe('working');
  });
});
