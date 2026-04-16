import { describe, expect, test } from "bun:test";
import { parseIntents } from "../src/core/intent-parser.ts";

describe("parseIntents", () => {
  test("extracts REMEMBER intents and strips them from the response", () => {
    const input = "Sure, I'll note that. [REMEMBER: Chris likes his coffee black]\nAll set.";
    const { clean, intents } = parseIntents(input);

    expect(intents).toEqual([{ type: "remember", content: "Chris likes his coffee black" }]);
    expect(clean).not.toContain("[REMEMBER");
    expect(clean).toContain("Sure, I'll note that.");
    expect(clean).toContain("All set.");
  });

  test("extracts GOAL without deadline", () => {
    const { intents, clean } = parseIntents("Plan: [GOAL: Ship hardening] Done.");
    expect(intents).toEqual([{ type: "goal", content: "Ship hardening" }]);
    expect(clean).not.toContain("[GOAL");
  });

  test("extracts GOAL with deadline", () => {
    const { intents } = parseIntents("[GOAL: Ship hardening | DEADLINE: tomorrow]");
    expect(intents).toEqual([{ type: "goal", content: "Ship hardening", deadline: "tomorrow" }]);
  });

  test("extracts DONE intents", () => {
    const { intents, clean } = parseIntents("Wrapped it up. [DONE: Shipped auth]");
    expect(intents).toEqual([{ type: "done", content: "Shipped auth" }]);
    expect(clean).toBe("Wrapped it up.");
  });

  test("handles multiple mixed intents across newlines", () => {
    const input = [
      "Update:",
      "[REMEMBER: API token path is ~/.clawster/api-token]",
      "[GOAL: Ship P1 | DEADLINE: EOD]",
      "[DONE: P0 audit]",
      "Thanks!",
    ].join("\n");

    const { intents, clean } = parseIntents(input);
    expect(intents).toHaveLength(3);
    expect(intents[0]).toMatchObject({ type: "remember" });
    expect(intents[1]).toMatchObject({ type: "goal", deadline: "EOD" });
    expect(intents[2]).toMatchObject({ type: "done" });
    expect(clean.startsWith("Update:")).toBe(true);
    expect(clean.endsWith("Thanks!")).toBe(true);
    expect(clean).not.toMatch(/\[(REMEMBER|GOAL|DONE)/);
  });

  test("collapses runs of 3+ blank lines left behind by tag removal", () => {
    const input = "Hi.\n[REMEMBER: x]\n\n\n\nBye.";
    const { clean } = parseIntents(input);
    expect(clean).not.toMatch(/\n{3,}/);
  });

  test("returns empty intents for a plain response", () => {
    const { intents, clean } = parseIntents("Just a normal message.");
    expect(intents).toEqual([]);
    expect(clean).toBe("Just a normal message.");
  });

  test("supports multi-line REMEMBER content", () => {
    const input = "[REMEMBER: first line\nsecond line]";
    const { intents } = parseIntents(input);
    expect(intents[0]).toMatchObject({ type: "remember" });
    expect(intents[0]!.content).toContain("first line");
    expect(intents[0]!.content).toContain("second line");
  });
});
