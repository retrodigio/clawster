# Clawster Setup Guide

Install and configure Clawster on a new machine.

## Prerequisites

- **Bun** (v1.0+): `curl -fsSL https://bun.sh/install | bash`
- **Claude Code CLI**: Install from https://claude.ai/download — verify with `claude --version`
- **Active Claude subscription**: Clawster uses `claude -p` which requires a subscription (no API key needed)
- **Telegram bot**: Create one via [@BotFather](https://t.me/BotFather) on Telegram
- **Your Telegram user ID**: Message [@userinfobot](https://t.me/userinfobot) to get it

### Optional

- **Groq API key**: For voice message transcription (get one at https://console.groq.com)
- **Open Brain**: Semantic memory server (separate setup, runs on localhost:3577)

## Installation

```bash
git clone https://github.com/retrodigio/clawster.git
cd clawster
bun install
bun link
```

After `bun link`, the `clawster` command is available globally.

## Initialize

```bash
clawster init
```

This walks you through:
1. Telegram bot token
2. Your Telegram user ID
3. Timezone (auto-detected)
4. Groq API key (optional)

Creates `~/.clawster/` with `config.json`, `agents.json`, `sessions/`, and `logs/`.

## Add Your First Agent

### Create the Telegram group

1. Create a new Telegram group
2. Add your bot to the group
3. Make the bot admin

### Discover the chat ID

```bash
clawster agent discover
```

Send a message in the group. Note the chat ID that appears. Press Ctrl+C.

### Register the agent

```bash
clawster agent add MyProject
```

Provide the workspace path and chat ID when prompted.

### Set up the workspace

```bash
clawster workspace init /path/to/project --name "MyProject"
```

Edit the generated `CLAUDE.md` to add project-specific context.

## Start Clawster

### Foreground (for testing)

```bash
clawster start
```

### As a daemon (auto-start on boot)

```bash
clawster daemon install
```

This installs a macOS launchd plist. The daemon auto-starts on login and restarts on crash.

To remove: `clawster daemon uninstall`

## Verify

```bash
clawster status
```

Send a message in your Telegram group. The agent should respond.

## Useful Commands

```bash
clawster agent list          # See all agents
clawster logs                # View recent logs
clawster stop                # Stop the orchestrator
clawster start               # Start again
```

## Troubleshooting

### Bot doesn't respond to messages

- Check `clawster status` — is the orchestrator running?
- Check `clawster logs` — look for errors
- Verify the bot is admin in the Telegram group
- Verify the chat ID matches with `clawster agent discover`
- Make sure `claude` CLI works: `claude -p "hello" --output-format text`

### "Config not found" errors

Run `clawster init` to create the config. Config lives at `~/.clawster/`.

### Session errors / stale sessions

Sessions are stored at `~/.clawster/sessions/`. If an agent gets stuck, delete its session file:

```bash
rm ~/.clawster/sessions/<agent-id>.json
```

### Claude process timeouts

Default timeout is 5 minutes. If agents consistently time out, the prompts may be too complex or Claude Code may be overloaded. Check `clawster logs` for timeout entries.

### "No default agent" error

One agent in `~/.clawster/agents.json` must have `"isDefault": true`. This agent handles messages from unrecognized chats.

### Port conflict on health check

Default health port is 18800. Change it in `~/.clawster/config.json` (`healthPort` field) if it conflicts.

### Daemon won't start

Check launchd logs:
```bash
cat ~/Library/Logs/clawster/stdout.log
cat ~/Library/Logs/clawster/stderr.log
```

Reinstall if needed: `clawster daemon uninstall && clawster daemon install`
