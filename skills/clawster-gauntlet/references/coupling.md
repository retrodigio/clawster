# The coupling check

Read this before writing the fan-out line of a gauntlet prompt.

## The finding

From Claude-of-Duty's own README, process notes — the part the hype skips.

Shumer ran three rounds of **six parallel agents** on the renderer. Result:
quality **+0.46**, and frame-ruining defects went **60 → 47 → 66** — up, net, from
where they started. Isolated agents with fresh context each fixed their own piece
by making an assumption the next agent's fix invalidated. Tonemapping, sky, and
lighting are not three pieces. They are one system with three names.

He then ran **one sequential pass with a single owner per coupled concern**.
Result: **+1.00**, defects **66 → 26**.

Twice the gain, and the defects actually went down. Same model, same bar, same
critic. The only variable was whether the work was split across agents that could
not see each other.

Upstream's template says "fan out a builder and a separate critic" with no
qualification. On separable pieces that is right and it is the whole reason the
pattern beats an ordinary review loop. On coupled pieces it is worse than doing
nothing clever at all.

## The test

A piece is **separable** if a change to it cannot invalidate a decision made
inside another piece. Ask directly: *if two agents worked on these simultaneously
without talking, could one of them break the other's work and neither notice?*

If yes, they are one piece with one owner.

## What is usually separable

- Rooms, levels, screens — distinct spatial or navigational units
- Chapters, sections, scenes — distinct narrative units with their own beats
- Independent components with no shared visual language decision inside them
- Distinct API endpoints or CLI subcommands
- Individual puzzles, individual illustrations, individual posts

## What is almost never separable

- **A design system.** Colour, type scale, spacing, motion tokens. One owner.
- **Lighting, tonemapping, post-processing.** Shumer's exact case.
- **Narrative voice, tone, reading level.** Six agents produce six voices.
- **A data schema or taxonomy.** For TileMap specifically: the 141-type taxonomy
  *is* the interface between the two models. Never fan out on it.
- **Rhyme scheme and meter.** Storytime's whole product is consistency here.
- **Brand voice across posts.** SocialManager's per-brand config exists for this.
- **Global performance budget.** One agent's win is another's regression.

## How to sequence it

Coupled concerns land **first**, from a single owner, before any fan-out begins.
The separable pieces then build on a settled foundation instead of racing to
define one. Getting this backwards — fanning out and hoping to unify later — is
how you get Shumer's 66 defects.

If the coupled concern *is* the whole job (a design-system refresh, a tone pass
over existing copy), there is no fan-out. It is one owner, one critic, one loop.
That is still a gauntlet — the bar and the blind comparison are what make it one,
not the parallelism.

## Say it in the prompt

Name both halves explicitly, even when one is empty:

> Split this into pieces that can be judged on their own — hero, pricing table,
> testimonials, and footer are independent, so fan out a builder and a separate
> critic on each. The type scale and colour tokens are one coupled system across
> all four: give those a single sequential owner and let that owner land first.

or, when nothing is separable:

> This is one coupled system — the rhyme scheme and voice run through every
> stanza. One builder, one critic, sequential. Do not fan out.

An unnamed split gets decided by the lead agent under fan-out pressure, and the
pressure only points one way.
