# Attribution and changes

`clawster-gauntlet` is a fork of **[gauntlet-loop](https://github.com/robonuggets/gauntlet-loop)**
by **Jay E** at [RoboNuggets](https://robonuggets.com), used and adapted under
**CC BY 4.0** (full text in `LICENSE`).

The **gauntlet loop technique itself is [Matt Shumer's](https://github.com/mshumer)**.
He wrote the [original prompt](https://github.com/mshumer/Claude-of-Duty/blob/main/prompt.md)
and named the loop while building [Claude of Duty](https://github.com/mshumer/Claude-of-Duty).
The harsh critic, the blind labels-stripped comparison, and the refusal to accept
"good enough" all come from that prompt. Neither the upstream skill nor this fork
is the technique — both are packaging.

Related reading: [Anthropic on building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
whose 2024 evaluator-optimizer pattern the loop extends by adding fan-out and an
external artifact in place of self-grading.

Forked 2026-08-29 from upstream `main`. Research behind the fork:
`~/projects/kb-clawster/raw/gauntlet-loop-research.md`.

---

## What this fork changes

Kept verbatim in substance: the flow, the three bar tests (Named / Fetchable /
Comparable), the prompt-generator shape, the ~150-word target, the binary-verdict
critic, and the failure-mode list. Those are the skill and they are not improved
by editing.

| # | Change | Why |
|---|---|---|
| 1 | **Budget ceiling on by default** (4 rounds / 45 min per piece) replacing "Do not stop before that" and upstream's explicit "No default cap" | This fleet runs headless under `bypassPermissions` on one shared subscription, with heartbeats every 30-60m and a global semaphore of 4. Upstream assumes a human watching a tab who can hit stop. Nobody here can. Measured worst case upstream: 137 agents / 22M tokens / 10 rounds (`jolbol1/apex-gp`). |
| 2 | **Coupling check before fan-out** — a required step, and a named line in the emitted prompt | Claude-of-Duty's own README measured parallel fan-out *losing* to sequential single-owner passes on coupled systems: +0.46 with defects 60→47→66, versus +1.00 with defects 66→26. Upstream says "fan out" unconditionally. |
| 3 | **Telegram checklist status** replacing "Keep a live progress page updating as the work evolves" | `conduct.md` §4 — one checklist message, edited as pieces land, new message on completion. An HTML page nobody has open is not status. |
| 4 | **Standing bars per project** — step 2 reads `<kb_path>/wiki/bars.md` before offering candidates | The bar is the whole trick and picking one costs a round-trip. Pre-picking them per project removes that, and stops a phone-typed "gauntlet this" from settling for a lazy bar. |
| 5 | **Escalation on the ceiling** — stop, report standing and next-round cost, do not self-extend | `conduct.md` §6. The ceiling is a stop, not a success. |
| 6 | **Perception is gated** — visual bars named as needing browser access | Only agents granted Claude Code's native Chrome integration (`clawster browser grant`, `extraArgs: { "chrome": null }`) can screenshot, and they must `select_browser` the Clawster profile's device id first. A visual critic without eyes is guessing, which is failure mode #1 wearing a hat. |
| 7 | **Model split** — lead offered Fable 5.1 before the first spawn (Opus 5 by default), builders on Sonnet 5, critics on Opus 5, and the model named explicitly on every spawn | The critic's judgment is the quality ceiling of the whole loop, and it is the cheaper role: few calls, short outputs. The lead's job is three low-volume, high-leverage decisions, which is what the deep-reasoning tier is for. Explicit naming exists because subagents inherit the lead's model — a Fable lead otherwise produces Fable builders silently (`3357bef`, reverted in `377d1a8`). |
| 8 | **A "when not to reach for this" section** | Upstream sells the pattern. A fleet skill has to also say where it wastes money. |

Rationale in full lives in `references/budget.md`, `references/coupling.md`, and
`references/running-in-the-fleet.md`.
