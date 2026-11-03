import { describe, expect, test } from "bun:test";
import { checkProposal, describeProposal, nearlySame, parseProposals, standing, DAY_MS, type Proposal } from "../src/core/proposal-policy.ts";
import type { AgentConfig } from "../src/core/types.ts";

const agent = { id: "demo", name: "Demo", workspace: "/tmp/demo", telegramChatId: "-1001000000001" } as AgentConfig;
const NOW = Date.UTC(2026, 10, 2, 18, 0, 0);
const rand = () => 0.5;
const good = {
  kind: "next", title: "Master the boss theme at -16 LUFS", summary: "Match the older tracks so the soundtrack plays evenly.",
  why_now: "The soundtrack is otherwise finished.", steps: ["Re-master the track", "A/B it against the others"], effort: "S",
  dedupe_key: "boss-theme-loudness", thread: "-1001000000001:7",
};
const filed = (over: Partial<Proposal>): Proposal => ({ id: "p261101-0001", agent: "demo", thread: "-1001000000001", kind: "next", title: "Something else entirely",
  summary: "s", why_now: "w", steps: ["x"], effort: "S", dedupe_key: "other", created_ms: NOW - 3 * DAY_MS, expires_ms: NOW + 4 * DAY_MS, ...over });

describe("checkProposal", () => {
  test("a good card gets an id, its timestamps and the kind's expiry", () => {
    const r = checkProposal(agent, good, [], {}, NOW, rand);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.id).toBe("p261102-8000");
    expect(r.card.created_ms).toBe(NOW);
    expect(r.card.expires_ms).toBe(NOW + 7 * DAY_MS);
    expect(r.replaced).toBe(false);
    const idea = checkProposal(agent, { ...good, kind: "idea", dedupe_key: "rush", title: "A boss rush mode" }, [], {}, NOW, rand);
    expect(idea.ok && idea.card.expires_ms).toBe(NOW + 21 * DAY_MS);
  });

  test("only the agent's own chat or a topic in it", () => {
    expect(checkProposal(agent, { ...good, thread: "-1009999999999" }, [], {}, NOW).ok).toBe(false);
    expect(checkProposal(agent, { ...good, thread: "-1001000000001:7:9" }, [], {}, NOW).ok).toBe(false);
    const r = checkProposal(agent, { ...good, thread: undefined }, [], {}, NOW);
    expect(r.ok && r.card.thread).toBe("-1001000000001");
  });

  test("plain words only: no links, addresses or tokens, one line, within the lengths", () => {
    for (const bad of [
      { title: "See https://example.com" }, { summary: "notes at t.me/c/123/4" }, { why_now: "ask at acme.com" },
      { title: "x".repeat(81) }, { title: "two\nlines" }, { steps: ["use key sk-abc123"] }, { steps: [] }, { steps: ["a", "b", "c", "d", "e", "f"] },
      { effort: "XL" }, { kind: "maybe" }, { dedupe_key: "has spaces" },
      { decision: { options: ["Only one"] } }, { decision: { options: ["A", "B"], recommended: "C" } },
    ]) expect([bad, checkProposal(agent, { ...good, ...bad }, [], {}, NOW).ok]).toEqual([bad, false]);
    expect(checkProposal(agent, { ...good, kind: "idea", decision: { options: ["A", "B"] } }, [], {}, NOW).ok).toBe(false);   // ideas carry no decision
    const d = checkProposal(agent, { ...good, decision: { options: ["-16", "-14"], recommended: "-16" } }, [], {}, NOW);
    expect(d.ok && d.card.decision).toEqual({ options: ["-16", "-14"], recommended: "-16" });
  });

  test("the same dedupe_key replaces the open card, keeping its id and age, and does not count as new", () => {
    const old = filed({ id: "p261101-aaaa", dedupe_key: "boss-theme-loudness", title: "Master the boss theme" });
    const two = [filed({ id: "p261102-0001", created_ms: NOW - 3600e3, dedupe_key: "a", title: "Alpha thing" }), filed({ id: "p261102-0002", created_ms: NOW - 1800e3, dedupe_key: "b", title: "Beta thing" })];
    const r = checkProposal(agent, good, [old, ...two], {}, NOW);
    expect(r.ok && [r.card.id, r.card.created_ms, r.replaced]).toEqual(["p261101-aaaa", old.created_ms, true]);
  });

  test("2 new cards a day, at most 1 idea, 6 open", () => {
    const today = (n: number, kind: "next" | "idea" = "next") => filed({ id: `p261102-000${n}`, created_ms: NOW - n * 3600e3, dedupe_key: `k${n}`, title: `Card number ${n} ${kind}`, kind });
    expect(checkProposal(agent, good, [today(1), today(2)], {}, NOW).ok).toBe(false);
    expect(checkProposal(agent, good, [today(1)], {}, NOW).ok).toBe(true);
    const r = checkProposal(agent, { ...good, kind: "idea" }, [today(1, "idea")], {}, NOW);
    expect(!r.ok && r.error).toContain("one a day");
    const six = [1, 2, 3, 4, 5, 6].map((n) => filed({ id: `p261020-000${n}`, created_ms: NOW - (3 + n) * DAY_MS, expires_ms: NOW + DAY_MS, dedupe_key: `o${n}`, title: `Older open card ${"abcdef"[n - 1]}` }));
    expect(checkProposal(agent, good, six, {}, NOW).ok).toBe(false);
    // a started card is no longer open; an expired one is gone
    expect(checkProposal(agent, good, six, { "p261020-0001": { status: "started" } }, NOW).ok).toBe(true);
  });

  test("a dismissed key is blocked for 90 days; a near-duplicate title is refused", () => {
    const gone = filed({ id: "p261001-dddd", dedupe_key: "boss-theme-loudness", title: "Loudness pass on the boss theme" });
    const r = checkProposal(agent, good, [gone], { "p261001-dddd": { status: "dismissed", at_ms: NOW - 10 * DAY_MS } }, NOW);
    expect(!r.ok && r.error).toContain("90 days");
    expect(checkProposal(agent, good, [gone], { "p261001-dddd": { status: "dismissed", at_ms: NOW - 91 * DAY_MS } }, NOW).ok).toBe(true);
    const twin = filed({ id: "p261101-eeee", dedupe_key: "other-key", title: "Master the boss theme at -16 LUFS now" });
    expect(checkProposal(agent, good, [twin], {}, NOW).ok).toBe(false);
  });
});

describe("helpers", () => {
  test("standing: dismissed and expired are gone; snoozed until a time; discussing never expires", () => {
    const c = filed({ expires_ms: NOW - 1 });
    expect(standing(c, undefined, NOW)).toBe("gone");
    expect(standing(c, { status: "discussing" }, NOW)).toBe("open");
    expect(standing(filed({}), { status: "snoozed", until_ms: NOW + 1 }, NOW)).toBe("snoozed");
    expect(standing(filed({}), { status: "snoozed", until_ms: NOW - 1 }, NOW)).toBe("open");
    expect(standing(filed({}), { status: "dismissed" }, NOW)).toBe("gone");
  });
  test("parseProposals keeps the last line per id and skips junk; nearlySame compares words", () => {
    const a = filed({ title: "first" }), b = filed({ title: "second" });
    expect(parseProposals(`${JSON.stringify(a)}\nnot json\n${JSON.stringify(b)}\n`).map((c) => c.title)).toEqual(["second"]);
    expect(nearlySame("Draw the remaining 13 covers", "draw the remaining 13 covers!")).toBe(true);
    expect(nearlySame("Draw the remaining covers", "Fix the audio mix")).toBe(false);
  });
  test("the notice names the agent, the kind and the title", () => {
    const r = checkProposal(agent, good, [], {}, NOW, rand);
    expect(r.ok && describeProposal(agent, r.card, false)).toBe("💡 New on the board's Up next — Demo proposes a next step: Master the boss theme at -16 LUFS");
  });
});
