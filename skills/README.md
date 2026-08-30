# Fleet skills

Skills that belong to the Clawster fleet rather than to one project. They are
versioned here, beside the daemon that runs the agents using them, and installed
by symlink so every workspace inherits them:

```bash
ln -sfn ~/claude-orchestrator/skills/<name> ~/.claude/skills/<name>
```

That mirrors the existing convention in `~/.claude/skills/`, where the entries are
symlinks into `~/.openclaw/skills/`. Editing the file here changes the installed
skill immediately — there is nothing to re-copy.

| Skill | What it does |
|---|---|
| `clawster-gauntlet` | Turns a goal into a paste-ready gauntlet-loop prompt — real quality bar, builder/critic pairs, blind comparison. Fleet-hardened: budget ceiling on by default, coupling check before fan-out, Telegram checklist status. Fork of `robonuggets/gauntlet-loop`, CC BY 4.0 — see its `NOTICE.md`. |
