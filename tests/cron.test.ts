import { describe, expect, test } from "bun:test";
import { matchesCron, getNextMatch } from "../src/core/cron.ts";

function at(hour: number, minute = 0): Date {
  // Wednesday 2026-06-10 as a fixed base date
  return new Date(2026, 5, 10, hour, minute, 0, 0);
}

describe("matchesCron", () => {
  test("plain ranges", () => {
    expect(matchesCron("0 8-22 * * *", at(8))).toBe(true);
    expect(matchesCron("0 8-22 * * *", at(22))).toBe(true);
    expect(matchesCron("0 8-22 * * *", at(7))).toBe(false);
    expect(matchesCron("0 8-22 * * *", at(23))).toBe(false);
  });

  test("wrapped (overnight) ranges match across midnight", () => {
    // "22-6" = 22:00 through 06:00 — the overnight activeHours case that
    // previously matched nothing and silently disabled heartbeats.
    expect(matchesCron("0 22-6 * * *", at(22))).toBe(true);
    expect(matchesCron("0 22-6 * * *", at(23))).toBe(true);
    expect(matchesCron("0 22-6 * * *", at(0))).toBe(true);
    expect(matchesCron("0 22-6 * * *", at(3))).toBe(true);
    expect(matchesCron("0 22-6 * * *", at(6))).toBe(true);
    expect(matchesCron("0 22-6 * * *", at(7))).toBe(false);
    expect(matchesCron("0 22-6 * * *", at(12))).toBe(false);
    expect(matchesCron("0 22-6 * * *", at(21))).toBe(false);
  });

  test("wrapped range with step", () => {
    // "22-6/2" → 22, 0, 2, 4, 6
    expect(matchesCron("0 22-6/2 * * *", at(22))).toBe(true);
    expect(matchesCron("0 22-6/2 * * *", at(23))).toBe(false);
    expect(matchesCron("0 22-6/2 * * *", at(0))).toBe(true);
    expect(matchesCron("0 22-6/2 * * *", at(1))).toBe(false);
    expect(matchesCron("0 22-6/2 * * *", at(4))).toBe(true);
    expect(matchesCron("0 22-6/2 * * *", at(12))).toBe(false);
  });

  test("steps, lists, exact values", () => {
    expect(matchesCron("*/30 * * * *", at(9, 0))).toBe(true);
    expect(matchesCron("*/30 * * * *", at(9, 30))).toBe(true);
    expect(matchesCron("*/30 * * * *", at(9, 15))).toBe(false);
    expect(matchesCron("0 9,17 * * *", at(9))).toBe(true);
    expect(matchesCron("0 9,17 * * *", at(17))).toBe(true);
    expect(matchesCron("0 9,17 * * *", at(12))).toBe(false);
  });

  test("getNextMatch finds the next overnight slot", () => {
    // From noon, the next "0 22-6 * * *" match is 22:00 the same day.
    const next = getNextMatch("0 22-6 * * *", at(12));
    expect(next.getHours()).toBe(22);
    expect(next.getMinutes()).toBe(0);
  });
});
