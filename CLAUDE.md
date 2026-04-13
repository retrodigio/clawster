# Clawster — CLAUDE.md

Clawster is an autonomous AI agent orchestrator. It routes messages from project-specific Telegram groups to `claude -p` CLI sessions, each running in its own project workspace. This is the main Clawster agent — it manages itself and helps Chris manage his fleet of agents.

## Architecture

```
Telegram group -> grammY bot -> Router (chatId -> agent) -> claude -p --cwd <workspace> -> response -> Telegram
```

- Each agent maps to a Telegram group chat and a local workspace directory
- Forum topics within a group get separate Claude sessions
- A global semaphore limits concurrent `claude -p` processes (default: 4)
- Per-agent mutex ensures one Claude process per agent at a time
- Sessions are persisted at `~/.clawster/sessions/` for conversation continuity
- Open Brain MCP provides shared semantic memory across all agents

## Tech Stack

- **Runtime**: Bun + TypeScript (strict mode, ESM)
- **Telegram**: grammY
- **AI backend**: `claude -p` CLI (subscription-powered, no API keys)
- **Memory**: Open Brain MCP server (Supabase pgvector, localhost:3577)
- **Daemon**: macOS launchd
- **CLI framework**: commander

## File Structure

```
src/
  cli/                    # CLI commands (commander subcommands)
    index.ts              # Entry point, registers all commands
    init.ts               # clawster init — first-time setup
    start.ts              # clawster start
    stop.ts               # clawster stop
    status.ts             # clawster status
    logs.ts               # clawster logs
    agent.ts              # clawster agent add|list|remove|discover
    workspace.ts          # clawster workspace init
    daemon.ts             # clawster daemon install|uninstall
    migrate.ts            # clawster migrate (from OpenClaw)
  core/
    agent-runner.ts       # Spawns claude -p with concurrency control
    bot.ts                # grammY bot setup and message routing
    config.ts             # Config loading from ~/.clawster/
    health.ts             # Health check endpoint
    heartbeat.ts          # Proactive agent check-ins
    intent-parser.ts      # Message intent classification
    lock.ts               # PID lock file management
    logger.ts             # Structured JSON logging
    message-sender.ts     # Telegram message sending with chunking
    prompt-builder.ts     # Prompt assembly for claude -p
    router.ts             # Chat ID -> agent resolution
    server.ts             # Main entry point (starts bot + heartbeats)
    session-store.ts      # Session ID persistence per agent+topic
    transcribe.ts         # Voice message transcription (Groq)
    types.ts              # TypeScript interfaces
  daemon/                 # launchd integration
config/
  agents.json             # Agent definitions (development/reference copy)
  mcp-open-brain.json     # MCP server config for Open Brain
daemon/
  *.plist                 # launchd plist files
  install-daemon.ts       # Daemon installer
  uninstall-daemon.ts     # Daemon uninstaller
scripts/
  discover-chats.ts       # Chat ID discovery helper
  migrate-workspaces.ts   # Migration from OpenClaw workspace files
  migrate-memory.ts       # Memory file ingestion into Open Brain
templates/                # Templates for new workspace CLAUDE.md files
```

## CLI Commands

| Command | Description |
|---|---|
| `clawster init` | First-time setup: bot token, user ID, timezone, creates ~/.clawster/ |
| `clawster start` | Start the orchestrator (bot + heartbeats) |
| `clawster stop` | Stop the running orchestrator |
| `clawster status` | Check health of running instance |
| `clawster logs` | View orchestrator logs |
| `clawster agent add <name>` | Add a new agent interactively |
| `clawster agent list` | List all configured agents |
| `clawster agent remove <name>` | Remove an agent |
| `clawster agent discover` | Listen for Telegram messages to discover chat IDs |
| `clawster workspace init <path>` | Generate CLAUDE.md for a workspace (--name, --merge) |
| `clawster daemon install` | Install launchd daemon for auto-start |
| `clawster daemon uninstall` | Remove launchd daemon |
| `clawster migrate` | Migrate from OpenClaw format |

## Config Structure

All config lives at `~/.clawster/` (or `$CLAWSTER_HOME`).

### ~/.clawster/config.json

```json
{
  "botToken": "123456:ABC...",
  "allowedUserId": "992115973",
  "timezone": "America/Denver",
  "claudePath": "claude",
  "healthPort": 18800,
  "maxConcurrent": 4,
  "groqKey": ""
}
```

Environment variable overrides: `CLAWSTER_BOT_TOKEN`, `CLAWSTER_USER_ID`, `CLAWSTER_TIMEZONE`, `CLAWSTER_GROQ_KEY`.

### ~/.clawster/agents.json

```json
{
  "agents": [
    {
      "id": "main",
      "name": "Zero",
      "workspace": "/Users/chriscrabtree/claude-orchestrator",
      "telegramChatId": "-1003761266939",
      "isDefault": true,
      "heartbeat": {
        "every": "30m",
        "target": "telegram",
        "to": "-1003761266939"
      }
    },
    {
      "id": "ironrod",
      "name": "IronRod",
      "workspace": "/Users/chriscrabtree/projects/ironrod",
      "telegramChatId": "-1003803061485",
      "topics": {
        "11": { "name": "Issues" }
      },
      "heartbeat": {
        "every": "1h",
        "activeHours": { "start": "08:00", "end": "22:00" },
        "target": "telegram",
        "to": "-1003803061485"
      }
    }
  ],
  "unboundChatIds": []
}
```

Agent fields:
- `id` — Unique identifier (lowercase, hyphenated)
- `name` — Display name
- `workspace` — Absolute path to project directory (must contain project files)
- `telegramChatId` — Telegram group chat ID (use `clawster agent discover` to find)
- `isDefault` — If true, this agent handles unrouted messages
- `topics` — Map of forum topic IDs to names (for supergroups with topics)
- `heartbeat.every` — Interval string: `"30m"`, `"1h"`, etc.
- `heartbeat.activeHours` — Optional window: `{ "start": "08:00", "end": "22:00" }`
- `heartbeat.target` — Always `"telegram"` for now
- `heartbeat.to` — Chat ID to send heartbeat messages to

## Adding a New Agent

### Via CLI (recommended)

```bash
clawster agent add MyProject
# Prompts for: workspace path, telegram chat ID, heartbeat config
```

Then create the workspace CLAUDE.md:
```bash
clawster workspace init /path/to/project --name "MyProject"
```

### By editing agents.json directly

Add an entry to the `agents` array in `~/.clawster/agents.json`:

```json
{
  "id": "myproject",
  "name": "MyProject",
  "workspace": "/Users/chriscrabtree/projects/myproject",
  "telegramChatId": "-100XXXXXXXXXX"
}
```

Then restart: `clawster stop && clawster start`.

### Finding the Telegram chat ID

1. Create a Telegram group (or supergroup) for the project
2. Add the bot to the group and make it admin
3. Run `clawster agent discover`
4. Send a message in the group — the chat ID will appear in the terminal
5. Press Ctrl+C when done

## Heartbeats

Agents with a `heartbeat` config proactively check in on their project. The heartbeat system:

1. Runs on the configured interval (e.g., every 30m or 1h)
2. Respects `activeHours` if set (skips outside the window, based on configured timezone)
3. Spawns `claude -p` with a prompt asking the agent to review project state
4. If the agent has something to report, it sends a Telegram message
5. If nothing notable, the agent responds `NO_CHECKIN` and stays silent
6. Initial ticks are staggered randomly (0-60s) to avoid thundering herd

## Open Brain Memory Integration

Open Brain is a shared semantic memory system running as an MCP server on localhost:3577. All agents connect to it via `config/mcp-open-brain.json`.

Usage from within an agent session:
- `ob search "query"` — Search memory semantically
- `ob capture "thought text"` — Save something to memory
- `ob recent` — Browse recent entries

When you (the Clawster agent) learn something important about a project or Chris's preferences, save it to Open Brain so other agents can benefit.

## Conventions

- **Bun runtime** — All scripts run via `bun`. Use `Bun.spawn`, `Bun.write`, etc.
- **TypeScript strict mode** — No implicit any, strict null checks
- **ESM only** — All imports use `.ts` extensions
- **Minimal dependencies** — grammY and commander are the only runtime deps
- **Structured JSON logging** — All log output is JSON to stdout (launchd captures to files)
- **Concurrency** — Global semaphore + per-agent mutex. Never run two claude processes for the same agent simultaneously.
- **Sessions** — Persisted at `~/.clawster/sessions/<agentId>.json` (or `<agentId>_topic_<topicId>.json`)
- **PID lock** — `~/.clawster/orchestrator.lock` prevents duplicate instances

## Current Agent Fleet

This machine runs the following agents (see agents.json for full config):
- **Zero** (main) — This agent. Manages Clawster itself.
- **IronRod** — /Users/chriscrabtree/projects/ironrod
- **LetterGnome** — /Users/chriscrabtree/projects/lettergnome
- **TileMap** — /Users/chriscrabtree/projects/tilemap
- **Sinigate** — /Users/chriscrabtree/projects/sinigate
- **Regex** — /Users/chriscrabtree/projects/regex
- **Gnomium** — /Users/chriscrabtree/projects/gnomium
- **JobArbiter** — /Users/chriscrabtree/projects/jobarbiter
- **Once Upon a Rhyme** — /Users/chriscrabtree/projects/storytime
- **Fisherman's Wife** — /Users/chriscrabtree/projects/fishermans-wife
- **SocialManager** — /Users/chriscrabtree/projects/social-manager

## About Chris

Chris Crabtree — 30+ year software engineer, serial entrepreneur. Mountain Time (MDT).
Prefers concise communication. Values speed, autonomy, and working code over process.
