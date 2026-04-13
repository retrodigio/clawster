# Clawster

Autonomous AI agent orchestrator — run Claude Code agents via Telegram.

Clawster connects your Telegram groups to Claude Code Agent SDK sessions, giving each project its own AI agent with persistent memory, separate conversation contexts, and proactive check-ins. All powered by your Claude subscription (no API keys needed).

## Quick Start

```bash
# Install
npm install -g clawster
# or: bun install -g clawster

# Set up (bot token, user ID, timezone)
clawster init

# Add your first project agent
clawster agent add myproject

# Install daemon and start
clawster daemon install

# Or run in foreground
clawster start --foreground
```

## Features

- **Agent SDK powered** — Uses `@anthropic-ai/claude-agent-sdk` for long-lived agent sessions (no spawn-per-message overhead)
- **Multi-agent routing** — Each Telegram group maps to a project agent running in its own workspace
- **Forum topic support** — Separate Claude sessions per Telegram topic within a group
- **Auto-discovery** — New groups and topics are automatically detected, matched to projects, and registered
- **Zero-orchestrated onboarding** — Send a message from a new Telegram group and the orchestrator agent will scaffold a new project for you through conversation
- **Shared semantic memory** — Open Brain MCP server provides cross-agent semantic memory
- **Real-time streaming** — Responses stream live to Telegram with message edits
- **Proactive heartbeats** — Agents check in on their projects and message you when something's noteworthy
- **Session persistence** — Conversations resume across restarts via session IDs
- **Cross-platform daemon** — macOS launchd and Linux systemd support
- **Per-project CLAUDE.md** — Each agent loads project-specific instructions automatically
- **Voice messages** — Transcribed via Groq and sent to the agent as text

## How It Works

```
Telegram message → grammY bot → Router (chatId → agent)
  → Agent SDK query() with streaming → live Telegram edits
  → session persists for next message
```

Clawster receives Telegram messages, routes them to the right project agent, and uses the Claude Code Agent SDK to handle each message. The SDK runs Claude with full tool access (Bash, Read, Edit, Glob, Grep, etc.) in the project workspace, loading the project's `CLAUDE.md` for context.

### Auto-Discovery Flow

When a message arrives from an unknown Telegram group:

1. **Name-match** — Fuzzy-matches the group name against `~/projects/` directories
2. **Auto-bind** — If matched, creates the agent config and starts routing immediately
3. **Zero onboarding** — If no match, the orchestrator agent asks you about the project via Telegram and scaffolds everything (directory, CLAUDE.md, agent config, git init)

New forum topics within existing groups are auto-registered on first message.

## Installation

### Prerequisites

- **Bun** runtime — https://bun.sh (`curl -fsSL https://bun.sh/install | bash`)
- **Claude Code** CLI installed and authenticated — `npm install -g @anthropic-ai/claude-code && claude`
- **Telegram bot** token from [@BotFather](https://t.me/BotFather)

### Install from npm

```bash
npm install -g clawster
```

### Setup

```bash
# Interactive setup — prompts for bot token, Telegram user ID, timezone
clawster init

# Add an agent for an existing project
clawster agent add MyProject
# Prompts for: workspace path, Telegram chat ID, heartbeat config

# Generate CLAUDE.md for the workspace (optional — merges existing config files)
clawster workspace init /path/to/project --name "MyProject" --merge

# Install the daemon (auto-start on login)
clawster daemon install
```

### Finding Telegram Chat IDs

The easiest way: create a Telegram group, add your bot, and send a message. Clawster will auto-discover the group and either match it to a project or start the onboarding flow.

Alternatively, if the orchestrator is already running, check the logs:
```bash
clawster logs -f
# Send a message in the group — the chat ID appears in the log
```

## CLI Reference

```
clawster init                    # Interactive setup (bot token, user ID, timezone)
clawster start [--foreground]    # Start the orchestrator
clawster stop                    # Stop the orchestrator
clawster status                  # Show health and agent info
clawster logs [-f]               # View logs (--follow for live tail)

clawster agent add <name>        # Add a new agent (interactive)
clawster agent list              # List all configured agents
clawster agent remove <name>     # Remove an agent

clawster daemon install          # Install platform daemon (launchd/systemd)
clawster daemon uninstall        # Remove daemon

clawster workspace init <path>   # Generate CLAUDE.md for a project directory
clawster migrate                 # Migrate from OpenClaw config
```

## Configuration

Config lives at `~/.clawster/` (or `$CLAWSTER_HOME`):

```
~/.clawster/
├── config.json    # Bot token, user ID, timezone, concurrency
├── agents.json    # Agent definitions and Telegram bindings
├── sessions/      # Per-agent conversation session IDs
└── logs/          # Structured JSON log files
```

### config.json

```json
{
  "botToken": "123456:ABC...",
  "allowedUserId": "your-telegram-user-id",
  "timezone": "America/Denver",
  "healthPort": 18800,
  "maxConcurrent": 4
}
```

### agents.json

```json
{
  "agents": [
    {
      "id": "myproject",
      "name": "MyProject",
      "workspace": "/home/user/projects/myproject",
      "telegramChatId": "-100XXXXXXXXXX",
      "heartbeat": {
        "every": "1h",
        "activeHours": { "start": "08:00", "end": "22:00" },
        "target": "telegram",
        "to": "-100XXXXXXXXXX"
      }
    }
  ]
}
```

### Environment Variables

Override config.json values:
- `CLAWSTER_BOT_TOKEN` — Telegram bot token
- `CLAWSTER_USER_ID` — Your Telegram user ID
- `CLAWSTER_TIMEZONE` — Timezone for prompts and heartbeats
- `CLAWSTER_HOME` — Config directory (default: `~/.clawster`)

## Architecture

Each agent gets:
- Its own workspace directory with `CLAUDE.md` for project context
- A persistent Claude Code Agent SDK session (resumes across messages)
- Its own Telegram group (with optional per-topic sessions)
- Optional heartbeat schedule for proactive check-ins
- Access to shared MCP servers (Open Brain semantic memory)

Concurrency is managed with a global semaphore (default: 4 concurrent agents) and per-agent mutexes to prevent overlapping queries.

### Platform Support

| Platform | Daemon | Status |
|----------|--------|--------|
| macOS    | launchd | Fully supported |
| Linux    | systemd (user service) | Supported |
| Windows  | — | Use `clawster start --foreground` |

## License

MIT
