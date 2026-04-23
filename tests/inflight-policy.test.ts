import { describe, expect, test } from "bun:test";
import { classifyInflightIntent } from "../src/core/inflight-policy.ts";

describe("classifyInflightIntent", () => {
  test("empty / whitespace → queue", () => {
    expect(classifyInflightIntent("")).toBe("queue");
    expect(classifyInflightIntent("   ")).toBe("queue");
    expect(classifyInflightIntent("\n\n")).toBe("queue");
  });

  test("normal conversational text → queue", () => {
    expect(classifyInflightIntent("hey can you also check the logs")).toBe("queue");
    expect(classifyInflightIntent("one more thing — fix the margin too")).toBe("queue");
    expect(classifyInflightIntent("thanks, that looks great")).toBe("queue");
    expect(classifyInflightIntent("What does the build output say?")).toBe("queue");
  });

  test("explicit leading ! → interrupt", () => {
    expect(classifyInflightIntent("!do this now")).toBe("interrupt");
    expect(classifyInflightIntent("!stop that and try this instead")).toBe("interrupt");
  });

  test("interrupt leaders → interrupt", () => {
    expect(classifyInflightIntent("wait")).toBe("interrupt");
    expect(classifyInflightIntent("Wait, I meant the other file")).toBe("interrupt");
    expect(classifyInflightIntent("STOP")).toBe("interrupt");
    expect(classifyInflightIntent("cancel that")).toBe("interrupt");
    expect(classifyInflightIntent("hold on, different idea")).toBe("interrupt");
    expect(classifyInflightIntent("hold up — scrap that")).toBe("interrupt");
    expect(classifyInflightIntent("nevermind")).toBe("interrupt");
    expect(classifyInflightIntent("never mind that approach")).toBe("interrupt");
    expect(classifyInflightIntent("scratch that")).toBe("interrupt");
    expect(classifyInflightIntent("disregard the last message")).toBe("interrupt");
    expect(classifyInflightIntent("actually, use the other one")).toBe("interrupt");
    expect(classifyInflightIntent("forget that, try this")).toBe("interrupt");
    expect(classifyInflightIntent("forget it — new plan")).toBe("interrupt");
    expect(classifyInflightIntent("abort, abort")).toBe("interrupt");
  });

  test("leading punctuation does not defeat the match", () => {
    expect(classifyInflightIntent("...wait, hold on")).toBe("interrupt");
    expect(classifyInflightIntent("  — actually, never mind")).toBe("interrupt");
  });

  test("word-boundary required: 'waitress' does not match 'wait'", () => {
    expect(classifyInflightIntent("waitress was rude")).toBe("queue");
    expect(classifyInflightIntent("stopwatch is broken")).toBe("queue");
    expect(classifyInflightIntent("cancellation policy is weird")).toBe("queue");
    expect(classifyInflightIntent("actually,I meant…")).toBe("interrupt"); // comma after
  });

  test("interrupt leader mid-sentence does NOT match (must be leading)", () => {
    expect(classifyInflightIntent("I know you said to wait")).toBe("queue");
    expect(classifyInflightIntent("please do not cancel the job")).toBe("queue");
  });

  test("!-override beats bias toward queue", () => {
    expect(classifyInflightIntent("!also look at this")).toBe("interrupt");
  });
});
