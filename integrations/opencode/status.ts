// OpenCode plugin: reports each session's state to the agent-status board.
// Install globally: cp this file to ~/.config/opencode/plugins/agent-status.ts
// Event shapes follow @opencode-ai/sdk's types.gen.ts (v1.19). Set AGENT_STATUS_DEBUG=1
// to log event types this plugin doesn't handle, which helps after OpenCode renames one.

const URL_ = process.env.AGENT_STATUS_URL ?? 'http://127.0.0.1:7777/events';
const HEARTBEAT_MS = 15_000;
const DEBUG = !!process.env.AGENT_STATUS_DEBUG;

type Props = Record<string, any>;

export const AgentStatus = async ({ directory }: { directory: string }) => {
  const known = new Set<string>();
  // Subagent sessions have a parent; they'd clutter the board, so skip them.
  const children = new Set<string>();
  const unhandled = new Set<string>();

  const send = (sessionId: string | undefined, event: string, extra: Props = {}) => {
    if (!sessionId || children.has(sessionId)) return;
    if (event === 'end') known.delete(sessionId); else known.add(sessionId);
    fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'opencode', sessionId, event, cwd: directory, pid: process.pid, ...extra }),
      signal: AbortSignal.timeout(1000),
    }).catch(() => {
      // The board isn't running; never let that affect OpenCode.
    });
  };

  const timer = setInterval(() => {
    for (const id of known) send(id, 'heartbeat');
  }, HEARTBEAT_MS);
  (timer as any).unref?.();

  const noteSession = (info: Props | undefined) => {
    if (info?.parentID) children.add(info.id);
    return info;
  };

  return {
    event: async ({ event }: { event: { type: string; properties: Props } }) => {
      const p = event.properties ?? {};
      switch (event.type) {
        case 'session.created': {
          const info = noteSession(p.info);
          return send(info?.id, 'start', { title: info?.title, cwd: info?.directory ?? directory });
        }
        case 'session.updated': {
          const info = noteSession(p.info);
          return send(info?.id, 'title', { title: info?.title });
        }
        case 'session.deleted':
          return send(p.info?.id, 'end');
        case 'session.status': {
          const status = p.status?.type;
          if (status === 'busy') return send(p.sessionID, 'prompt');
          if (status === 'retry') return send(p.sessionID, 'tool', { detail: `Retrying (attempt ${p.status.attempt}): ${p.status.message ?? ''}` });
          if (status === 'idle') return send(p.sessionID, 'idle');
          return;
        }
        case 'session.idle':
          return send(p.sessionID, 'idle');
        case 'session.error': {
          const err = p.error;
          const msg = err?.data?.message ?? err?.name ?? 'The session reported an error.';
          return send(p.sessionID, 'error', { detail: String(msg) });
        }
        // permission.updated in the v1 SDK types, permission.asked in the current docs.
        case 'permission.updated':
        case 'permission.asked':
          return send(p.sessionID, 'permission', { tool: p.type ?? p.permission, detail: p.title ?? (Array.isArray(p.patterns) ? p.patterns.join(', ') : undefined) });
        case 'permission.replied':
          return send(p.sessionID, 'tool_done');
        case 'message.part.updated': {
          const part = p.part;
          if (part?.type === 'tool' && part.state?.status === 'running') {
            const input = part.state.input ?? {};
            const arg = part.state.title ?? input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.url;
            return send(part.sessionID, 'tool', { tool: part.tool, detail: typeof arg === 'string' ? arg : undefined });
          }
          return;
        }
        default:
          if (DEBUG && !unhandled.has(event.type)) {
            unhandled.add(event.type);
            console.error(`[agent-status] unhandled event ${event.type}`);
          }
      }
    },
  };
};
