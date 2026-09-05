---
name: clawster-gauntlet
description: Turns a goal into one short, paste-ready "gauntlet loop" prompt — set a real quality bar, split the work into judgeable pieces, run a builder and a separate harsh critic on each, compare blind against the bar, and loop until it wins. Fleet-hardened for Clawster - budget ceiling on by default, a coupling check before fan-out, and Telegram checklist status instead of an HTML progress page. Triggers on "/clawster-gauntlet", "gauntlet this", "gauntlet loop", "run a gauntlet on", "loop until it beats X", "make a gauntlet prompt".
---

# Clawster Gauntlet

The user gives a goal. You give back ONE short prompt they can paste into a fresh
session — or run here.

You are not doing the work. You are writing the prompt that makes another agent
grind on the work until it beats a real reference.

Technique by Matt Shumer; skill packaging by Jay E (RoboNuggets). This is a fork —
see `NOTICE.md` for attribution and the exact diff against upstream.

## Flow

1. **Read the goal.** One line restatement in your head, not on screen.
2. **Set the bar.** Check `<kb_path>/wiki/bars.md` first — most projects have
   standing bars already picked. If one fits, name it and move on. If not, offer
   **2 or 3 candidate bars**, one line each, and stop. Wait for their pick.

   If nobody handed you a `kb_path`, work it out from the working directory:
   `~/projects/<name>` or `~/projects/<name>-repo` means the KB is
   `~/projects/kb-<name>`. Check whether it exists before assuming it does, and
   say which bars page you read.
3. **Run the coupling check.** Name which pieces are separable and which share
   global state. Only separable pieces get parallel pairs. See below.
4. **Set the ceiling.** Always. Never emit a gauntlet prompt with no budget line.
5. **Write the prompt.** One block, paste-ready, no preamble, no headings inside
   it, no narration after it.
6. **Offer to run it.** One flat line under the prompt: "I can run this here."
   Not a question.
7. **Offer Fable for the lead — before starting, not after.** If they say run it,
   ask once, in one line: "Run the lead on Fable 5.1? Otherwise Opus 5." Default
   to Opus 5 if they do not answer or do not care. Ask before the first spawn,
   because switching the lead mid-run resets the context that holds the coupling
   call.

If they say run it, you become the lead agent and follow the prompt you just wrote.
Read `references/running-in-the-fleet.md` before you do — the model split there is
not optional, and getting it wrong is silent.

## The bar is the whole trick

Everything else is scaffolding. The loop only produces quality if the thing it
compares against is real.

- **Named.** A specific thing, not a category. "Stripe's pricing page" works.
  "Award-winning SaaS sites" does not.
- **Fetchable.** The critic can actually get it — screenshot the live page, read
  the published piece, run the binary, open the repo. If it cannot obtain the
  reference, it hallucinates the comparison and approves everything. This is the
  single most common failure.
- **Comparable.** Both can sit side by side and a judge can pick one. If you
  cannot imagine the A/B, it is not a bar.

Prefer the hardest bar the agent can genuinely reach. A bar that is too easy
makes the loop exit on round one. If the goal has a measurable half — load time,
token cost, benchmark score, pass rate — name it alongside the reference.

Standing bars per project live at `<kb_path>/wiki/bars.md`. Template:
`references/bars.template.md`.

## Coupling check — before any fan-out

Shumer measured this on Claude-of-Duty and it is the fork's main structural
addition. Three rounds of six parallel agents moved quality +0.46 and left
frame-ruining defects *higher* (60→47→66). One sequential pass with a single
owner per coupled concern moved +1.00 and cut defects 66→26.

So: **fan out only what is genuinely separable.** Pieces that share global state —
a design system, lighting, narrative voice, a data schema, a taxonomy — are one
system and get one sequential owner. Isolated agents on a coupled system break
each other's assumptions faster than they fix anything.

Say the split out loud in the prompt. Detail and worked examples:
`references/coupling.md`.

## The ceiling is on by default

Upstream deliberately ships no cap and says "do not stop". That is correct for a
human watching a browser tab, and wrong here: this fleet runs headless under
`bypassPermissions`, on one shared subscription, with heartbeats every 30-60m and
a global semaphore of 4. An uncapped multi-hour fan-out starves every other agent.

Real cost data: a community F1 game built this way took **137 agents, 22M tokens,
10 rounds**. A landing page took 1h19m. Assume hours, not minutes.

Default ceiling if the user names none: **4 rounds or 45 minutes, whichever comes
first, per piece.** At the ceiling the agent stops, reports where it stands and
what another round would cost, and waits. It does not extend itself — that is
`conduct.md` §6, and it is the only brake there is.

Sizing guidance and how to pick a different ceiling: `references/budget.md`.

## Prompt template

Adapt the wording every time. Fill the brackets, keep it short, keep the last line.

```
Build [GOAL].

The bar is [BAR]. Get the real thing first and compare against it directly, not
against a description of it.

Split this into the smallest pieces that can be improved and judged on their own.
[SEPARABLE PIECES] are independent — fan out a builder and a separate critic on
each, naming the model on every spawn: builders on sonnet, critics on opus.
[COUPLED CONCERNS] share global state and get one sequential owner instead,
not parallel agents.

Each critic is a separate agent with fresh context. It inspects the actual output,
puts it next to the bar blind with the labels stripped, says which one is better,
and names the single biggest remaining gap. Then it goes back to the builder. Be
harsh — praise is not useful. A binary pick, never a score out of 10.

Budget: [N] rounds or [T] per piece, whichever comes first. At the ceiling, stop
and report where each piece stands and what another round would cost. Do not
extend the budget yourself.

Keep one Telegram checklist message updated as pieces land, and post a new message
when you stop — done, stalled, or out of budget.

Loop each piece until the critic picks ours blind, or the budget ends it. Fan out
subagents and ultracode.
```

Rules for what you fill in:

- Bake the bar in as a concrete, fetchable thing. URL, product name, repo, title.
- The budget line is **not optional**. Use the default if the user named none.
- Name the coupled concerns explicitly, even when the answer is "none".
- Add tool names only if the goal needs them — a browser for visual bars, image
  generation, a deploy target.
- Everything else stays out. No architecture, no file layout, no stack choice
  unless the user demanded it. The agent decides those, and it decides better than
  a spec written before the work started.

## Length and voice

Short. Around 200 to 215 words — upstream targets 150, and the fork's three
structural additions account for the whole overrun: the budget line, the coupling
line, and the model-naming clause. Nothing else earns words. If the prompt needs a
heading to stay readable, it is too long.

Plain sentences. No bullet lists inside the prompt. It should read like someone
telling an agent what perfect looks like and refusing to accept less.

## Portability

`/loop` and `ultracode` are Claude Code features. `/loop` reruns the prompt on an
interval or lets the model pace itself; `ultracode` opts the turn into multi-agent
orchestration.

For any other agent, swap the last line for: "Keep looping until the critic picks
ours or the budget ends it. Run the builders and critics as parallel subagents."
For a session with no Telegram tools, swap the status line for a progress file the
user can tail. The structure carries over unchanged.

## Worked example

User: "the IronRod Story Mode chapter transition feels cheap."

`kb-ironrod/wiki/bars.md` already names the bar, so no round-trip:

```
Rebuild the IronRod Story Mode chapter transition so it feels Apple-quality —
reverent, cinematic, and satisfying rather than merely animated.

The bar is Apple's own product-page scroll choreography at apple.com/iphone.
Screenshot it and screen-record it at desktop and mobile, and compare against
those directly, not against a description of them.

Split this into pieces that can be judged on their own — entry, hold, exit,
type treatment, and touch response. Those five are independent; fan out a builder
and a separate critic on each, naming the model on every spawn: builders on
sonnet, critics on opus. Easing curves and the shared motion tokens are one
coupled system across all five, so give those a single sequential owner and let
that owner land first.

Each critic is a separate agent with fresh context. It screen-records our
transition, puts it next to the reference blind with the labels stripped, says
which one is better, and names the single biggest remaining gap. Then it goes
back to the builder. Be harsh — praise is not useful. A binary pick, never a
score out of 10.

Budget: 4 rounds or 45 minutes per piece, whichever comes first. At the ceiling,
stop and report where each piece stands and what another round would cost. Do not
extend the budget yourself.

Keep one Telegram checklist message updated as pieces land, and post a new message
when you stop.

Loop each piece until the critic picks ours blind, or the budget ends it. Fan out
subagents and ultracode.
```

I can run this here.

## What breaks a gauntlet loop

- **A vague bar.** The critic invents a comparison and approves everything. Most
  common failure by far.
- **A visual critic with no eyes.** If the bar is visual and the critic cannot
  screenshot both sides, it is guessing. That means Claude Code's native Chrome
  integration, granted per agent and needing the right browser selected first —
  see `references/running-in-the-fleet.md`. No browser, no visual gauntlet; pick
  a non-visual bar instead of pretending.
- **The builder judging its own work.** The critic must be a separate agent with
  fresh context. It should not know how hard the builder tried.
- **Spawning without naming a model.** Subagents inherit the lead's model. A Fable
  lead silently produces Fable builders and Fable critics, at Fable prices, and
  nothing in the output says so. Name the model on every spawn.
- **A soft critic.** Say "harsh" and give it a binary job. Scores out of 10 drift
  upward every round — Claude-of-Duty's went 3.59 → 5.05 while every critic still
  picked the real game.
- **A fixed round count as the *goal*.** The exit is winning the comparison. The
  budget ceiling is a stop, not a success — report it as unfinished, because it is.
- **Using it as the initial prompt.** It optimizes hard toward whatever direction
  the agent already picked, on-brief or not. Use it as a polish pass on something
  already on-brief.
- **Over-specifying.** Every extra instruction is one fewer decision the agent
  makes with its own judgment.

## When not to reach for this

- Code whose only real bar is its own test suite. Cheaper loops already exist.
- Anything with no fetchable reference. Without a bar this is just an expensive
  review.
- First drafts. See above.
