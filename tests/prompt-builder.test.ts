import { describe, expect, test } from "bun:test";
import { buildPrompt } from "../src/core/prompt-builder.ts";
import type { AgentConfig, MessageContext } from "../src/core/types.ts";

const agent: AgentConfig = {
  id: "zero",
  name: "Zero",
  workspace: "/tmp/zero",
  telegramChatId: "-100",
};

const baseCtx: MessageContext = {
  agentId: "zero",
  chatId: "-100",
  isPrivate: false,
};

describe("buildPrompt", () => {
  test("prefixes with topic label when topicId + topicName are given", () => {
    const ctx: MessageContext = { ...baseCtx, topicId: 11, topicName: "Issues" };
    const prompt = buildPrompt(agent, "Hello", ctx, "America/Denver");

    expect(prompt.startsWith("[Zero — Issues]")).toBe(true);
    expect(prompt).toContain("Current time:");
    expect(prompt.endsWith("Hello")).toBe(true);
  });

  test("falls back to 'Topic #N' label when topicName is missing", () => {
    const ctx: MessageContext = { ...baseCtx, topicId: 42 };
    const prompt = buildPrompt(agent, "hi", ctx, "America/Denver");
    expect(prompt.startsWith("[Zero — Topic #42]")).toBe(true);
  });

  test("omits topic label when there is no topicId", () => {
    const prompt = buildPrompt(agent, "hi", baseCtx, "America/Denver");
    expect(prompt).not.toContain("[Zero —");
    expect(prompt).toContain("Current time:");
    expect(prompt).toContain("hi");
  });

  test("includes the given timezone in the formatted time line", () => {
    const promptNY = buildPrompt(agent, "hi", baseCtx, "America/New_York");
    const promptUTC = buildPrompt(agent, "hi", baseCtx, "UTC");
    // Timezone string (e.g. EST/EDT/UTC/GMT) should appear — exact value varies
    // seasonally, so we just assert the two differ.
    expect(promptNY).not.toBe(promptUTC);
  });

  test("defaults timezone to America/Denver when unspecified", () => {
    const prompt = buildPrompt(agent, "hi", baseCtx);
    expect(prompt).toContain("Current time:");
  });

  test("joins parts with blank lines (three newline-separated blocks at most)", () => {
    const ctx: MessageContext = { ...baseCtx, topicId: 5, topicName: "General" };
    const prompt = buildPrompt(agent, "body", ctx);
    const blocks = prompt.split("\n\n");
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toBe("body");
  });

  test("hoists a /goal directive to the very top of the prompt", () => {
    const prompt = buildPrompt(agent, "/goal tests pass", baseCtx, "America/Denver");
    expect(prompt.startsWith("/goal tests pass")).toBe(true);
    expect(prompt).toContain("Current time:");
  });

  test("keeps any follow-up text after the /goal line as the user message body", () => {
    const prompt = buildPrompt(
      agent,
      "/goal CHANGELOG has an entry per merged PR\n\nStart with the api package.",
      baseCtx,
      "America/Denver",
    );
    const blocks = prompt.split("\n\n");
    expect(blocks[0]).toBe("/goal CHANGELOG has an entry per merged PR");
    expect(blocks[blocks.length - 1]).toBe("Start with the api package.");
  });

  test("does not match /goal in the middle of a message", () => {
    const prompt = buildPrompt(agent, "Some context. /goal foo", baseCtx);
    expect(prompt.startsWith("/goal")).toBe(false);
    expect(prompt).toContain("Some context. /goal foo");
  });

  test("/goal hoisting precedes topic label and time header", () => {
    const ctx: MessageContext = { ...baseCtx, topicId: 11, topicName: "Issues" };
    const prompt = buildPrompt(agent, "/goal ship it", ctx);
    const blocks = prompt.split("\n\n");
    expect(blocks[0]).toBe("/goal ship it");
    expect(blocks[1]).toBe("[Zero — Issues]");
    expect(blocks[2]?.startsWith("Current time:")).toBe(true);
    // No user body block after the goal — the message was nothing but the directive.
    expect(blocks).toHaveLength(3);
  });
});
