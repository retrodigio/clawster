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
    browser.ts            # clawster browser init|status|chrome
    daemon.ts             # clawster daemon install|uninstall
    migrate.ts            # clawster migrate (from OpenClaw)
  core/
    activity-timeout.ts   # Tool-aware inactivity/max timeout state machine
    agent-runner.ts       # Spawns Claude SDK queries with concurrency control
    bot.ts                # grammY bot setup and message routing
    config.ts             # Config loading from ~/.clawster/ (incl. secrets env file)
    config-store.ts       # Single source of truth for runtime config + change events
    intent-parser.ts      # Message intent classification
    lock.ts               # PID lock file management
    logger.ts             # Structured JSON logging
    message-sender.ts     # Telegram message sending with chunking
    message-wal.ts        # Inbound-message write-ahead log (restart loss detection)
    prompt-builder.ts     # Prompt assembly for agent queries
    router.ts             # Chat ID -> agent resolution
    scheduler.ts          # Heartbeats and cron-scheduled tasks
    semaphore.ts          # Priority-aware concurrency semaphore
    server.ts             # Main entry point (starts bot + scheduler + web API)
    session-store.ts      # Session ID persistence per agent+topic
    transcribe.ts         # Voice message transcription (Groq)
    types.ts              # TypeScript interfaces
    web-api.ts            # Local HTTP API + dashboard backend (loopback only)
config/
  agents.json             # Agent definitions (development/reference copy)
  mcp-servers.json        # MCP server registry (open-brain + restricted servers like playwright)
daemon/
  com.claude.open-brain.plist  # launchd plist for the Open Brain MCP server
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
| `clawster stop` | Stop the running orchestrator (waits for in-flight work to drain) |
| `clawster restart` | Restart the daemon atomically (launchctl kickstart) |
| `clawster status` | Check health of running instance (shows error-log tail when down) |
| `clawster logs` | View orchestrator logs (`--error` for the error log, `-f` to follow) |
| `clawster msg <agentId> "text"` | Send a message to another agent (`--broadcast` for all) |
| `clawster agent add <name>` | Add a new agent interactively |
| `clawster agent list` | List all configured agents |
| `clawster agent remove <name>` | Remove an agent |
| `clawster agent discover` | Listen for Telegram messages to discover chat IDs |
| `clawster workspace init <path>` | Generate CLAUDE.md for a workspace (--name, --merge) |
| `clawster daemon install` | Install launchd daemon for auto-start |
| `clawster daemon uninstall` | Remove launchd daemon |
| `clawster migrate` | Migrate from OpenClaw format |
| `clawster browser init` | Walk through Chrome + Playwright-MCP setup |
| `clawster browser status` | Check whether Chrome is reachable on CDP port 9222 |
| `clawster browser chrome` | Print the Chrome launch command (for copy/paste) |

## Config Structure

All config lives at `~/.clawster/` (or `$CLAWSTER_HOME`).

### ~/.clawster/config.json

```json
{
  "allowedUserId": "992115973",
  "timezone": "America/Denver",
  "claudePath": "claude",
  "healthPort": 18800,
  "maxConcurrent": 4,
  "models": {
    "conversation": "opus",
    "planning": "fable",
    "implementation": "sonnet"
  }
}
```

`models` maps each **mode** to a `--model` value the Claude CLI accepts (line
aliases like `fable`/`sonnet`/`opus`, or full IDs like `claude-fable-5`). See
"Model Modes" below.

### ~/.clawster/env (secrets)

Secrets never live in config.json — `saveConfig` strips them on every write.
They live in `~/.clawster/env` (mode 0600), plain `KEY=VALUE` lines:

```
CLAWSTER_BOT_TOKEN=123456:ABC...
CLAWSTER_GROQ_KEY=gsk_...
```

`loadConfig()` reads this file (real environment variables win on conflict),
and `clawster daemon install` merges its entries — plus any vars already in the
installed plist — into the daemon's `EnvironmentVariables`, so regenerating the
plist never drops the bot token.

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
- `mcpServers` — Per-agent allowlist of restricted MCP servers (see Browser MCP below)

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

Then restart: `clawster restart`. (Agent edits made through the web API or by
the running orchestrator itself hot-reload — no restart needed.)

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

## Model Modes (three-tier hierarchy)

Every chat (and every forum topic) runs in one of three **modes**, each mapped to
a model in `config.json` → `models`:

| Mode | Default model | Use for |
|---|---|---|
| `conversation` | `opus` | Front-facing orchestrator chat — the default tier |
| `planning` | `fable` | Deep reasoning, codebase analysis, authoring implementation plans |
| `implementation` | `sonnet` | Agentic coding — executing a plan, background subagents |

**Switching (per chat/topic, from Telegram):**

| Command | Effect |
|---|---|
| `/convo` | Switch this chat to conversation mode (Opus — default) |
| `/plan` | Switch this chat to planning mode (Fable — deep reasoning) |
| `/fable` | Alias for `/plan` |
| `/build` | Switch this chat to implementation mode (Sonnet — coding) |
| `/mode` | Show the current mode; `/mode convo` / `/mode plan` / `/mode build` also set it |
| `/status` | Reports the active mode + resolved model |

**How resolution works** (`src/core/model-resolver.ts`): the effective mode is
the per-chat value set via `/convo`/`/plan`/`/build` (persisted in `~/.clawster/modes/`,
survives restarts), falling back to the agent's `defaultMode`, then to
`conversation`. The model string is `config.models[mode]`, with an optional
per-agent `models` override merged on top. The runner resolves the model once
per run (a stall-retry reuses the same model). When no resolver is wired (tests),
it falls back to the built-in default `claude-opus-4-8`.

**Per-agent overrides** (`agents.json`): an agent may set `defaultMode`
(`"conversation"` | `"planning"` | `"implementation"`) and/or `models` (partial
override of the fleet map, e.g. `{ "implementation": "sonnet" }`). Set
`defaultMode: "implementation"` on agents that only run background/scheduled work
(no conversational Telegram presence) to keep heartbeats on Sonnet.

## Open Brain Memory Integration

Open Brain is a shared semantic memory system running as an MCP server on localhost:3577. All agents connect to it via `config/mcp-servers.json` (the `open-brain` entry).

Usage from within an agent session:
- `ob search "query"` — Search memory semantically
- `ob capture "thought text"` — Save something to memory
- `ob recent` — Browse recent entries

When you (the Clawster agent) learn something important about a project or Chris's preferences, save it to Open Brain so other agents can benefit.

## MCP Server Registry + Per-Agent ACL

All MCP servers live in `config/mcp-servers.json`. Each entry may carry an optional `restricted: true` flag.

- **Non-restricted servers** (e.g. `open-brain`) are attached to every agent automatically.
- **Restricted servers** are only attached to agents that explicitly opt-in via `agents.json` → `mcpServers: ["server-name"]`.

Today the only restricted server is `playwright`, because the dedicated debug Chrome it drives accumulates authenticated logins. Granting an agent `playwright` means that agent can navigate, click, and screenshot any site you've logged into in the debug profile — so grant it deliberately, not fleet-wide.

### Browser MCP (Playwright)

The `playwright` MCP attaches over the Chrome DevTools Protocol to a **dedicated debug Chrome** with its own user-data-dir at `~/.clawster/chrome-debug-profile/`. This matches OpenClaw's default driver pattern (Playwright + persistent profile), not its `existing-session` mode.

Why dedicated and not your daily Chrome:
- `open -a "Google Chrome" --args --remote-debugging-port=9222` silently drops the flag when any Chrome process is already running (helper processes, profile pickers, etc.). A separate user-data-dir forces a brand-new process tree that always honors the flag.
- Smaller blast radius. Only the sites you log into in the debug profile are reachable by agents — banking, work email, etc. in your daily Chrome stay untouched.
- No conflict with your daily browsing. Agent automations don't grab focus from your tabs.

**One-time setup:**

```bash
clawster browser init       # launches dedicated debug Chrome, waits for CDP endpoint
clawster browser status     # checks whether the debug Chrome is up
clawster browser chrome     # prints the Chrome launch command (for copy/paste)
```

After `init`, log into the sites you want agents to reach (facebook.com/marketplace, ksl.com/classifieds, etc.) in the new Chrome window. Cookies persist in the debug profile; future runs skip the login dance.

**Environment overrides:**
- `CLAWSTER_BROWSER_PROFILE` — override the debug-profile path (default `~/.clawster/chrome-debug-profile`).
- `CLAWSTER_CHROME_BIN` — override the Chrome binary path (defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS, `/usr/bin/google-chrome` on Linux).
- `CLAWSTER_BROWSER_AUTOLAUNCH=0` — disable auto-launch; print the command instead.

**Granting an agent access:**

Add `"mcpServers": ["playwright"]` to its entry in `agents.json`. Today only `main` (Zero) has this.

**Security trade-off:** the debug Chrome inherits any site you log into *in that profile*. Keep `mcpServers: ["playwright"]` narrow. Family agents (Bugs' Bot, Aust' Bot) must never get it. Also: the CDP port (9222) has no auth — any process on localhost can connect. Acceptable for a single-user Mac; revisit if untrusted local code ever runs on this box.

## Conventions

- **Bun runtime** — All scripts run via `bun`. Use `Bun.spawn`, `Bun.write`, etc.
- **TypeScript strict mode** — No implicit any, strict null checks
- **ESM only** — All imports use `.ts` extensions
- **Minimal dependencies** — grammY and commander are the only runtime deps
- **Structured JSON logging** — All log output is JSON to stdout (launchd captures to files)
- **Concurrency** — Global semaphore + per-agent mutex. Never run two claude processes for the same agent simultaneously.
- **Sessions** — Persisted at `~/.clawster/sessions/<agentId>.json` (topics: `<agentId>-topic-<topicId>.json`; scheduled runs: `<agentId>-scheduled.json` so heartbeats never advance the user's conversation)
- **PID lock** — `~/.clawster/clawster.lock` prevents duplicate instances

## Operations

### Log rotation

Clawster's `src/core/logger.ts` writes structured JSON to **stdout** only — it never opens log files itself. The daemon's log files at `~/.clawster/logs/clawster.log` and `~/.clawster/logs/clawster.error.log` are owned by launchd (via `StandardOutPath` / `StandardErrorPath` in `~/Library/LaunchAgents/com.clawster.daemon.plist`). Rotating those files from inside the Clawster process is therefore not possible — launchd holds the file descriptors.

Log rotation is the **operator's responsibility** and must be handled by the OS:

- **macOS** — use `newsyslog` (built in). Install by running `scripts/install-log-rotation.sh`, which drops a config into `/etc/newsyslog.d/clawster.conf`. The default policy rotates at 10 MB and keeps 5 gzip-compressed generations (`clawster.log.0.gz` … `clawster.log.4.gz`).
- **Linux (systemd)** — use `logrotate`. Equivalent `/etc/logrotate.d/clawster` snippet:
  ```
  /home/YOU/.clawster/logs/*.log {
      size 10M
      rotate 5
      compress
      missingok
      notifempty
      copytruncate
  }
  ```
  `copytruncate` is important here: journald/launchd-equivalent supervisors keep the descriptor open, so the rotator must truncate in place rather than rename.

The macOS `newsyslog.conf` syntax used by the install script is:
```
# logfilename              [owner:group]  mode count size  when  flags
/Users/YOU/.clawster/logs/clawster.log       644  5    10240 *   ZN
/Users/YOU/.clawster/logs/clawster.error.log 644  5    10240 *   ZN
```
Flags: `Z` = compress with gzip, `N` = don't signal any process (launchd keeps the descriptor; copytruncate-style behavior). Size is in KB, so `10240` = 10 MB. `*` in the `when` column means size-only trigger.

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

## Session Startup

At the start of every session, read these files to load who you are and who you're working with:
- `SOUL.md` — personality, values, voice
- `IDENTITY.md` — role, expertise, capabilities
- `USER.md` — facts about Chris, preferences, context

These shape *how* you respond. The rest of this file shapes *what* you work on.

## Session Resume Protocol

On every new session start, check `~/.clawster/worklog.json` for in-progress work. If it exists:
1. Read it to understand what was being worked on
2. Briefly tell Chris what you found and ask if he wants to resume
3. After completing major milestones or before any expected restart, update the worklog

The worklog tracks: active task, completed steps, next steps, and files changed. Keep it current — it's your lifeline across restarts.

## About Chris

Chris Crabtree — 30+ year software engineer, serial entrepreneur. Mountain Time (MDT).
Prefers concise communication. Values speed, autonomy, and working code over process.
