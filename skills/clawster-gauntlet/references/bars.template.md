# Bars template

Copy this into a project KB as `<kb_path>/wiki/bars.md`. It is the standing list
of quality references for that project, so a phone-typed "gauntlet this" needs no
bar-picking round-trip.

Every bar must pass all three tests or it does not belong on the page:

- **Named** — a specific thing, not a category
- **Fetchable** — the critic can screenshot it, read it, run it, or open it
- **Comparable** — both can sit side by side and a judge can pick one

A bar that fails "fetchable" is worse than no bar, because the critic will invent
the comparison and approve everything.

---

```markdown
---
updated: YYYY-MM-DD
---

# <Project> — quality bars

Standing references for `clawster-gauntlet`. Each is Named, Fetchable, Comparable.

| Surface | Bar | How the critic fetches it | Measurable half |
|---|---|---|---|
| <what is being built> | <the specific named thing> | <screenshot at 1440px / read the post / run the repo> | <load time, pass rate, word count — or —> |

## Coupled concerns — never fan out on these

- <the shared design system, voice, schema, taxonomy>

## Notes

- <why these bars and not others; what was rejected as too easy>

## Not applicable

- <surfaces of this project a gauntlet would waste money on, and why>
```

---

## Choosing well

**Prefer the hardest bar the agent can genuinely reach.** A bar that is too easy
makes the loop exit on round one, and an exit on round one teaches nothing.

**Prefer a bar the project is actually trying to be like.** The gauntlet optimizes
hard toward whatever it is pointed at. Point it at a beautiful page in the wrong
idiom and you get a beautiful page in the wrong idiom — that is exactly what
happened to the RoboNuggets KetoneIQ demo, which looked great and matched the
brand's real design system not at all.

**Name the measurable half when one exists.** Taste plus a number beats taste
alone, and the number is the half that cannot drift.

**Write down what you rejected.** The next person picking a bar for this project
should not have to re-litigate why the obvious one is wrong.
