# Clawster

Autonomous AI agent orchestrator — run Claude Code agents via Telegram.

Clawster connects your Telegram groups to Claude Code CLI sessions, giving each project its own AI agent with persistent memory, separate conversation contexts, and proactive check-ins. All powered by your Claude subscription (no API keys needed).

## Quick Start

```bash
# Install
bun install -g clawster

# Set up
clawster init

# Add your first project agent
clawster agent add myproject

# Start
clawster start --foreground
```

## Features

- **Multi-agent routing** — Each Telegram group maps to a project agent running in its own workspace
- **Forum topic support** — Separate Claude sessions per Telegram topic within a group
- **Shared semantic memory** — Open Brain (Supabase pgvector) provides cross-agent memory search
- **Proactive heartbeats** — Agents check in on their projects and message you when something's interesting
- **Always-on daemon** — macOS launchd keeps agents running 24/7
- **Per-project CLAUDE.md** — Each agent loads project-specific context automatically

## How It Works

```
Telegram message → grammY bot → Router (chatId → agent)
    → claude -p --cwd <workspace> → response → Telegram
```

Clawster is a relay — it receives Telegram messages, routes them to the right project directory, and spawns `claude -p` (Claude Code CLI) to handle each message. Claude Code reads the project's `CLAUDE.md` for context, uses local tools (git, files, etc.), and sends back a response.

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
clawster agent discover          # Listen for Telegram messages to discover chat IDs

clawster daemon install          # Install macOS launchd daemon
clawster daemon uninstall        # Remove daemon

clawster workspace init <path>   # Generate CLAUDE.md for a project directory
clawster migrate                 # Migrate from claude-orchestrator config
```

## Requirements

- **macOS** (launchd daemon support; Linux support planned)
- **Bun** runtime (https://bun.sh)
- **Claude Code** CLI installed and authenticated (`claude --version`)
- **Telegram bot** token from @BotFather

## Configuration

Config lives at `~/.clawster/`:

```
~/.clawster/
├── config.json    # Bot token, user ID, timezone, ports
├── agents.json    # Agent definitions and Telegram bindings
├── sessions/      # Per-agent conversation sessions
└── logs/          # Log files
```

### Environment Variables

Override config.json values:
- `CLAWSTER_BOT_TOKEN` — Telegram bot token
- `CLAWSTER_USER_ID` — Your Telegram user ID
- `CLAWSTER_TIMEZONE` — Timezone for prompts and heartbeats
- `CLAWSTER_HOME` — Config directory (default: `~/.clawster`)

## Architecture

Clawster is intentionally minimal — two runtime dependencies (grammY + commander) and one core insight: shell out to `claude -p` so everything runs under your Claude subscription.

Each agent gets:
- Its own workspace directory with `CLAUDE.md` for project context
- A separate Claude Code session (persisted across messages)
- Its own Telegram group (or topic within a group)
- Optional heartbeat schedule for proactive check-ins

## License

MIT
