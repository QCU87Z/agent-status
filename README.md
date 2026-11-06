# agent-status

One local page that shows every Claude Code and OpenCode session you have open, and whether it's working, waiting for your prompt, waiting on a permission, or gone. Sessions run independently (no tmux). Each one reports to a small server on `127.0.0.1:7777`.

```
Claude Code ──hooks (curl)──┐
OpenCode ──plugin (fetch + 15s heartbeat)──┼──▶ server :7777 ──SSE──▶ http://127.0.0.1:7777
```

## Run the board

```bash
npm install
npm start            # or: npm run dev (restarts on change)
open http://127.0.0.1:7777
```

Requires Node ≥ 22. State is kept in `~/.agent-status/state.json`, so restarting the server keeps the list. Env: `PORT`, `HOST`, `DATA_DIR`.

## Connect Claude Code

Merge the `hooks` from `integrations/claude/hooks.json` into `~/.claude/settings.json`. If you already have hooks for the same events, add the hook entries alongside yours. To try it on one session without touching your settings:

```bash
claude --settings ~/Development/agent-status/integrations/claude/hooks.json
```

Each hook pipes Claude's hook JSON to the server with a 1 s timeout and ignores failures, so Claude is unaffected when the board isn't running. The server walks up from the hook's parent PID to Claude's own process, and marks the session ended when that process exits.

## Connect OpenCode

```bash
mkdir -p ~/.config/opencode/plugins
cp integrations/opencode/status.ts ~/.config/opencode/plugins/agent-status.ts
```

The plugin reports session, permission and tool events and sends a heartbeat every 15 s. Subagent (child) sessions are skipped. Set `AGENT_STATUS_URL` to point somewhere other than `http://127.0.0.1:7777/events`, and `AGENT_STATUS_DEBUG=1` to log event types it doesn't handle (useful if an OpenCode update renames one).

## States

| State | Claude Code | OpenCode |
|---|---|---|
| Waiting for prompt | SessionStart, Stop, idle notification | session.created, session.idle, status idle |
| Working | UserPromptSubmit, Pre/PostToolUse | status busy/retry, running tool part, permission replied |
| Needs permission | permission notification | permission.updated / permission.asked |
| Error | — | session.error |
| Ended | SessionEnd, or the process is gone | session.deleted, or the process is gone |
| Stale | a working session with no PID and no events for 10 min | |

Ended sessions are forgotten after an hour, or straight away with Dismiss.

## API

- `POST /events`: `{ agent, sessionId, event, cwd?, pid?, title?, tool?, detail? }`, where `event` is one of `start prompt tool tool_done permission idle error end heartbeat title`
- `POST /events/claude?pid=N`: a raw Claude Code hook payload
- `GET /api/sessions`, `DELETE /api/sessions/:key`, `GET /stream` (SSE: `snapshot`, `session`, `remove`)

## Develop

```bash
npm test && npm run typecheck
```
