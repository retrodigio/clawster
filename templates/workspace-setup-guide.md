# Setting Up a New Clawster Workspace

Guide for provisioning a new project workspace and binding it to a Telegram group.

## Prerequisites

- Clawster installed and initialized (`clawster init` completed)
- A Telegram bot token configured
- The project directory exists (or you'll create it)

## Steps

### 1. Create or choose the project directory

```bash
mkdir -p ~/projects/my-project
cd ~/projects/my-project
git init  # if starting fresh
```

### 2. Initialize the workspace CLAUDE.md

```bash
clawster workspace init ~/projects/my-project --name "MyProject"
```

This generates a `CLAUDE.md` in the project root with default sections for identity, communication style, memory integration, and conventions.

If the project already has OpenClaw-style files (IDENTITY.md, SOUL.md, etc.), merge them:

```bash
clawster workspace init ~/projects/my-project --name "MyProject" --merge
```

### 3. Customize the generated CLAUDE.md

Edit `~/projects/my-project/CLAUDE.md` to add:

- Project-specific context (what the project does, tech stack, key files)
- Build/run/test commands
- Any domain knowledge the agent needs
- Coding conventions specific to this project

### 4. Create a Telegram group

1. Open Telegram and create a new group (or supergroup for topic support)
2. Name it something identifiable (e.g., "MyProject")
3. Add your Clawster bot to the group
4. Make the bot an admin (required for it to read messages)

### 5. Discover the chat ID

```bash
clawster agent discover
```

Send a message in the new group. The terminal will print the chat ID. Press Ctrl+C when done.

### 6. Add the agent

```bash
clawster agent add MyProject
```

When prompted:
- **Workspace path**: `~/projects/my-project`
- **Telegram chat ID**: paste the ID from step 5
- **Heartbeat**: configure if you want proactive check-ins (optional)

### 7. Restart Clawster

```bash
clawster stop && clawster start
```

### 8. Test it

Send a message in the Telegram group. The agent should respond using the project's CLAUDE.md context.

## Tips

- Use `clawster agent list` to verify the agent appears correctly
- Use `clawster status` to check the orchestrator is running
- Use `clawster logs` to debug if messages aren't being routed
- Forum topics in supergroups get separate Claude sessions automatically
- The agent reads `CLAUDE.md` from the workspace root on every invocation, so edits take effect immediately
