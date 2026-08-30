# Budget — sizing a gauntlet run

Read this when the default ceiling is wrong for the job, or when a run hits its
ceiling and you need to say what another round would cost.

## Why the fork caps at all

Upstream is explicit that it adds **no default cap** and ends every prompt with
"Do not stop before that." That is right for its assumed setting: a human at a
keyboard with a browser tab open and a stop button.

That setting does not exist here.

- Agents run headless as `claude -p` under `bypassPermissions`. There is no
  permission prompt behind them and no human watching the tab.
- One shared Claude subscription serves the whole fleet.
- `maxConcurrent` is 4 (`~/.clawster/config.json`). A fan-out of six builder/critic
  pairs does not run six-wide; it queues, and it queues *everyone else* behind it.
- Heartbeats fire every 30-60m across ~16 agents. An uncapped multi-hour gauntlet
  starves them silently.

The cap is not thrift. It is the thing that keeps one polish pass from taking the
fleet down for an afternoon.

## What runs actually cost

| Run | Cost |
|---|---|
| `jolbol1/apex-gp` — community F1 game, full visual gauntlet | **137 agents, 22M tokens, 10 rounds** |
| Karpathy's Lord-of-the-Rings run | ~2h, ~1M tokens (~$10 on API pricing) |
| RoboNuggets apartment walkthrough | 2h+, still iterating when the video ended |
| RoboNuggets landing page | 1h19m |

Nothing in that table finishes in minutes. Assume hours and a five-to-seven-figure
token count, and size the ceiling before starting rather than discovering it.

## The default

**4 rounds or 45 minutes per piece, whichever comes first.**

Per *piece*, not per run — a five-piece fan-out with this ceiling can still consume
hours of wall clock, which is why the coupling check matters as much as the cap.
If total spend is the real constraint, say so in the prompt as a run-level ceiling
instead: "Budget: 90 minutes total across all pieces."

## Picking a different ceiling

| Situation | Ceiling |
|---|---|
| Text or prose against a named author | 3 rounds — prose converges fast and the critic is cheap |
| A single visual surface (one page, one screen) | 4 rounds / 45 min — the default |
| A visual system (several screens sharing a design language) | 6 rounds, but sequence the shared concern first and count only the separable pieces |
| Code against a benchmark or test suite | Bound by the measurable half, not by rounds — "until the benchmark passes or 5 rounds" |
| Anything running while Chris is asleep | Halve it. Nobody is going to answer the escalation until morning. |

Raise the ceiling only when the previous run stopped *at* it with the critic still
naming real gaps. A run that stopped because the critic had nothing left to say
does not need more budget; it needs a harder bar.

## Hitting the ceiling

The ceiling is a **stop, not a success.** Report it as unfinished.

Per `conduct.md` §6, the agent does not extend its own budget. At the ceiling it
posts a new Telegram message (not an edit — edits do not notify) containing:

1. Which pieces won their blind comparison and which did not.
2. For each piece that did not: the single biggest remaining gap the critic named.
3. What another round would plausibly cost, in rounds and wall clock.
4. Nothing else. No "shall I continue?" menu — one offer or none.

Then it waits. Silently extending a budget on a shared subscription is exactly the
irreversible-ish action the escalation rules exist to stop.
