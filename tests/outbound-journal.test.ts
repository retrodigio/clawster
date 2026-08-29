import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP = mkdtempSync(join(tmpdir(), "clawster-journal-"));
process.env.CLAWSTER_HOME = TMP;

// Import AFTER setting CLAWSTER_HOME so getClawsterHome resolves to the tmp dir.
const {
  appendOutbound,
  readRecentOutbound,
  formatJournalForPrompt,
  telegramPermalink,
  getJournalDir,
} = await import("../src/core/outbound-journal.ts");

const TZ = "America/Denver";

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(getJournalDir(), { recursive: true, force: true });
});

describe("telegramPermalink", () => {
  test("supergroup id strips the -100 prefix", () => {
    expect(telegramPermalink("-1003803061485", 42)).toBe("https://t.me/c/3803061485/42");
  });

  test("a forum topic becomes the middle segment", () => {
    expect(telegramPermalink("-1003803061485", 42, 11)).toBe(
      "https://t.me/c/3803061485/11/42",
    );
  });

  test("non-supergroup chats have no permalink form", () => {
    // A plain group or a DM is not addressable by t.me/c — returning a link
    // that 404s would be worse than returning none.
    expect(telegramPermalink("-449182", 42)).toBeUndefined();
    expect(telegramPermalink("992115973", 42)).toBeUndefined();
  });
});

describe("appendOutbound / readRecentOutbound", () => {
  test("round-trips an entry and flattens the claim to one line", async () => {
    await appendOutbound({
      agentId: "ironrod",
      task: "check",
      chatId: "-1003803061485",
      topicId: 11,
      messageId: 900,
      text: "Build is red on main.\n\nThe audio test suite fails at commit abc1234.",
    });

    const entries = await readRecentOutbound("ironrod");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.claim).toBe(
      "Build is red on main. The audio test suite fails at commit abc1234.",
    );
    expect(entries[0]!.permalink).toBe("https://t.me/c/3803061485/11/900");
    expect(entries[0]!.task).toBe("check");
  });

  test("truncates a long claim with an ellipsis", async () => {
    await appendOutbound({
      agentId: "ironrod",
      task: "assess",
      chatId: "-1003803061485",
      messageId: 901,
      text: "x".repeat(1000),
    });

    const [entry] = await readRecentOutbound("ironrod");
    expect(entry!.claim.length).toBe(240);
    expect(entry!.claim.endsWith("…")).toBe(true);
  });

  test("journals are per agent", async () => {
    await appendOutbound({ agentId: "a", task: "check", chatId: "-100111", messageId: 1, text: "from a" });
    await appendOutbound({ agentId: "b", task: "check", chatId: "-100222", messageId: 2, text: "from b" });

    expect((await readRecentOutbound("a")).map((e) => e.claim)).toEqual(["from a"]);
    expect((await readRecentOutbound("b")).map((e) => e.claim)).toEqual(["from b"]);
  });

  test("returns the most recent N, oldest first", async () => {
    for (let i = 1; i <= 12; i++) {
      await appendOutbound({
        agentId: "ironrod",
        task: "check",
        chatId: "-1003803061485",
        messageId: i,
        text: `entry ${i}`,
      });
    }

    const entries = await readRecentOutbound("ironrod", 3);
    expect(entries.map((e) => e.claim)).toEqual(["entry 10", "entry 11", "entry 12"]);
  });

  test("keeps the file bounded at 200 entries", async () => {
    for (let i = 1; i <= 205; i++) {
      await appendOutbound({
        agentId: "ironrod",
        task: "check",
        chatId: "-1003803061485",
        messageId: i,
        text: `entry ${i}`,
      });
    }

    const lines = readFileSync(join(getJournalDir(), "ironrod.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(200);
    expect(JSON.parse(lines[0]!).claim).toBe("entry 6");
  });

  test("an unknown agent reads as empty, not an error", async () => {
    expect(await readRecentOutbound("never-ran")).toEqual([]);
    expect(existsSync(join(getJournalDir(), "never-ran.jsonl"))).toBe(false);
  });

  test("a corrupt line is skipped rather than poisoning the read", async () => {
    await appendOutbound({ agentId: "ironrod", task: "check", chatId: "-100111", messageId: 1, text: "good" });
    const { appendFileSync } = await import("fs");
    appendFileSync(join(getJournalDir(), "ironrod.jsonl"), "{ not json\n");

    const entries = await readRecentOutbound("ironrod");
    expect(entries.map((e) => e.claim)).toEqual(["good"]);
  });
});

describe("formatJournalForPrompt", () => {
  test("an empty journal contributes nothing to the prompt", () => {
    expect(formatJournalForPrompt([], TZ)).toBe("");
  });

  test("renders the claim, the link, and the unresolved-blocker rule", async () => {
    await appendOutbound({
      agentId: "ironrod",
      task: "check",
      chatId: "-1003803061485",
      topicId: 11,
      messageId: 900,
      text: "Build is red on main.",
    });

    const block = formatJournalForPrompt(await readRecentOutbound("ironrod"), TZ);
    expect(block).toContain("Build is red on main.");
    expect(block).toContain("https://t.me/c/3803061485/11/900");
    // Conduct §8: silence after a reported blocker is ambiguous.
    expect(block).toContain("NO_CHECKIN is forbidden");
  });
});
