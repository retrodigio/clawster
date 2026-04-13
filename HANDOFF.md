# Clawster — Session Handoff

## Date: 2026-04-13

## What We Built Today

Clawster v0.2.0 — a full Claude Code native multi-agent orchestrator replacing OpenClaw. Built from scratch in one session: core relay, CLI, npm package, daemons, streaming, voice, scheduled tasks, session management.

**Repo**: https://github.com/retrodigio/clawster
**npm**: https://www.npmjs.com/package/clawster (v0.2.0)

## Current Architecture (spawn-per-message)

```
Telegram message → grammY bot → Router (chatId → agent)
  → Bun.spawn("claude -p <message> --resume <sessionId> --fork-session")
  → stream-json output → live Telegram message edits
  → save session ID for next message
```

Each message spawns a new `claude -p` process. Session continuity via `--resume --fork-session` (CodeLayer pattern). Works, but has cold-start overhead per message (~3-5 seconds).

## What Needs to Happen Next: Agent SDK Migration

### Why

The Claude Code Agent SDK (TypeScript: `@anthropic-ai/claude-agent-sdk`) provides:
- **Long-lived processes** per agent (no spawn overhead)
- **Streaming input** — send multiple queries into a running agent
- **True persistent sessions** — `continue: true` resumes conversation
- **OAuth subscription auth** — `CLAUDE_CODE_OAUTH_TOKEN` works for personal use (Anthropic confirmed Feb 2026)
- **In-process hooks and MCP** — no need for external stdio bridges
- **Subagent spawning** — agents can delegate to specialized agents

### Auth Setup

Get the OAuth token:
```bash
claude setup-token
# or extract from existing auth
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

Chris's existing tokens are in `~/.openclaw/agents/main/agent/auth-profiles.json`:
- `anthropic:claude`: `sk-ant-oat01-KGwLwGFPsFo9I7eDT5LH9u-...`
- `anthropic:openclaw`: `sk-ant-oat01-0VTCjvR-0VSzM5FSxRdACg...`

### Target Architecture

```
Telegram message → grammY bot → Router (chatId → agent)
  → Agent SDK query() with streaming
  → accumulate response → Telegram message edits
  → session persists in-process (no spawn/resume cycle)

Each agent = one long-lived Agent SDK process
  - Maintains conversation context across messages
  - Full tool access (Bash, Read, Edit, Glob, Grep, etc.)
  - MCP servers (Open Brain) wired in-process
  - Monitor tool available for background processes
```

### Key Agent SDK Patterns (from docs)

**Basic query:**
```typescript
import { query, ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Check git status",
  options: { allowedTools: ["Bash", "Read", "Edit", "Glob", "Grep"] }
})) {
  if (message.type === "text") console.log(message.text);
}
```

**Continue session:**
```typescript
for await (const message of query({
  prompt: "Now fix the failing test",
  options: { continue: true }
})) { /* ... */ }
```

**With system prompt:**
```typescript
options: {
  systemPromptAdditions: "You are IronRod, a scripture study app agent...",
  allowedTools: ["Bash", "Read", "Edit", "Glob", "Grep", "WebSearch"],
  mcpServers: { "open-brain": { type: "url", url: "http://localhost:3577/mcp" } }
}
```

### Files to Change

**Replace** `src/core/agent-runner.ts`:
- Instead of `Bun.spawn("claude -p ...")`, use Agent SDK `query()` 
- Maintain one SDK client per agent (or per agent+topic)
- `query()` with streaming for real-time Telegram updates
- `continue: true` for follow-up messages
- Session management handled by SDK internally

**Update** `src/core/bot.ts`:
- Pass messages to SDK query instead of spawning processes
- Streaming handled via async generator from SDK
- Interrupt = cancel the current query and start a new one

**Update** `src/core/server.ts`:
- Initialize Agent SDK clients per agent on startup
- Each client has its own working directory and system prompt (from CLAUDE.md)

**Keep unchanged**:
- `src/cli/*` — all CLI commands stay the same
- `src/core/config.ts` — config loading unchanged
- `src/core/router.ts` — routing unchanged
- `src/core/scheduler.ts` — task scheduling unchanged (calls runner differently)
- `src/core/bot.ts` — grammY setup unchanged, just the handler internals change

### Install SDK

```bash
bun add @anthropic-ai/claude-agent-sdk
```

Or if that's not the exact package name, check:
```bash
npm search claude-agent-sdk
```

### Test First

Before refactoring everything, verify SDK + OAuth works:
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-...";

for await (const msg of query({ prompt: "Say hello" })) {
  console.log(msg);
}
```

If this works with the subscription token, proceed with full refactor.

## Current State of Everything

### What's Working
- 11 agents configured in `~/.clawster/agents.json`
- Telegram routing (verified: IronRod, JobArbiter, Zero Topics, LetterGnome, Regex, Gnomium, Sinigate, TileMap, Social Manager)
- Session persistence with `--resume --fork-session`
- True streaming (stream-json → Telegram edits)
- Voice transcription (Groq)
- Scheduled tasks with cron
- Open Brain memory (927 thoughts, HNSW index)
- launchd daemon (com.clawster.daemon)
- Full CLI (clawster init/start/stop/status/agent/daemon/workspace/migrate)

### Known Issues
- Daemon PATH must include `~/.local/bin` for claude CLI (fixed)
- Health server must not crash on port conflict (fixed)
- Default timeout is 10 minutes (may need tuning)
- Storytime + Fisherman's Wife chat IDs unverified
- Only IronRod topic 11 ("Issues") mapped; other topics unmapped
- Zero Topics forum topics unmapped

### Key File Locations
- Source: `~/claude-orchestrator/`
- Config: `~/.clawster/config.json`, `~/.clawster/agents.json`
- Sessions: `~/.clawster/sessions/`
- Logs: `~/.clawster/logs/clawster.log`
- Daemon: `~/Library/LaunchAgents/com.clawster.daemon.plist`
- Open Brain: `~/projects/open-brain/` (Supabase: igonvwmidziujqdndphk)
- Memory files: `~/.claude/projects/-Users-chriscrabtree-claude-orchestrator/memory/`

### Agent Chat ID Reference
| Agent | Chat ID | Verified |
|-------|---------|----------|
| main (Zero) | -1003761266939 | Yes |
| ironrod | -1003803061485 | Yes |
| jobarbiter | -1003848670783 | Yes |
| lettergnome | -1003576819554 | Yes |
| social-manager | -1003899853975 | Yes |
| regex | -5030379623 | Yes |
| gnomium | -5156650949 | Yes |
| sinigate | -5286195668 | Yes |
| tilemap | -5227530955 | Yes |
| storytime | -1003871367709 | NOT verified |
| fishermans-wife | -1003707457068 | NOT verified |

### OpenClaw Reference (if needed)
- Config: `~/.openclaw/openclaw.json` (all agent definitions, telegram bindings, bot token)
- Bot token: `8593279252:AAGoGzUv_eTqqOELEO1RD49-c_M6JAUwj3g`
- Chris's Telegram user ID: `992115973`
- Goda Go's relay pattern: `/tmp/claude-telegram-relay/`
- CodeLayer architecture: `/tmp/codelayer/` (humanlayer/humanlayer repo)
