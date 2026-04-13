# Claude Orchestrator

Multi-agent Telegram relay for Claude Code. Routes messages from project-specific Telegram groups to `claude -p` CLI sessions running in each project's workspace.

## Tech Stack
- **Runtime**: Bun + TypeScript (strict, ESM)
- **Telegram**: grammY
- **AI**: `claude -p` CLI (subscription-powered, not API keys)
- **Memory**: Open Brain MCP (Supabase pgvector, port 3577) + per-project CLAUDE.md
- **Daemon**: macOS launchd

## Architecture
```
Telegram → grammY bot → Router (chatId → agent) → claude -p --cwd <workspace> → response → Telegram
```

Each agent has its own workspace directory with a CLAUDE.md for project context. Forum topics within a Telegram group get separate Claude sessions. Open Brain provides shared semantic memory across all agents via MCP.

## Key Files
- `config/agents.json` — Agent definitions, Telegram bindings, heartbeat configs
- `config/mcp-open-brain.json` — MCP server config for Open Brain
- `src/agent-runner.ts` — Core: spawns claude -p with concurrency control
- `src/bot.ts` — grammY bot setup and message routing
- `src/router.ts` — Chat ID to agent resolution

## Commands
- `bun run start` — Start the orchestrator
- `bun run dev` — Start with watch mode
- `bun run status` — Check health of running instance
- `bun run migrate:workspaces` — Generate CLAUDE.md per project from OpenClaw files
- `bun run migrate:memory` — Ingest memory files into Open Brain

## Conventions
- Minimal dependencies (grammY is the only runtime dep)
- Structured JSON logging to stdout (launchd captures to log files)
- Per-agent mutex + global semaphore for concurrency
- Session IDs persisted per agent+topic at ~/.claude-orchestrator/sessions/
- PID lock at ~/.claude-orchestrator/orchestrator.lock
