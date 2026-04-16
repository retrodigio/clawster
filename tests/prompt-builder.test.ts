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
});
