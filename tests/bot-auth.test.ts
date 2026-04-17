import { describe, expect, test } from "bun:test";
import { decideAuth } from "../src/core/bot.ts";
import type { AgentConfig } from "../src/core/types.ts";

const OWNER_ID = "992115973";

function makeAgent(id: string, chatId: string): AgentConfig {
  return {
    id,
    name: id,
    workspace: `/tmp/${id}`,
    telegramChatId: chatId,
  } as AgentConfig;
}

// Build a resolveAgent that maps specific chat IDs to agents (and only
// treats group-ish chats as mappable, since that's how the real router behaves).
function makeResolver(mapping: Record<string, AgentConfig>) {
  return (chatId: string, isPrivate: boolean): AgentConfig | null => {
    if (isPrivate) return null;
    return mapping[chatId] ?? null;
  };
}

describe("decideAuth", () => {
  const mappedChatId = "-1003761266939";
  const unmappedChatId = "-1009999999999";
  const agent = makeAgent("main", mappedChatId);
  const resolveAgent = makeResolver({ [mappedChatId]: agent });

  test("owner in DM → allow (owner)", () => {
    const d = decideAuth({
      fromId: OWNER_ID,
      chatId: OWNER_ID,
      chatType: "private",
      allowedUserId: OWNER_ID,
      resolveAgent,
    });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toBe("owner");
  });

  test("owner in mapped group → allow (owner, owner path short-circuits)", () => {
    const d = decideAuth({
      fromId: OWNER_ID,
      chatId: mappedChatId,
      chatType: "supergroup",
      allowedUserId: OWNER_ID,
      resolveAgent,
    });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toBe("owner");
  });

  test("non-owner in mapped supergroup → allow (mapped_group)", () => {
    const d = decideAuth({
      fromId: "11111",
      chatId: mappedChatId,
      chatType: "supergroup",
      allowedUserId: OWNER_ID,
      resolveAgent,
    });
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.reason).toBe("mapped_group");
      expect(d.agent?.id).toBe("main");
    }
  });

  test("non-owner in mapped 'group' (non-super) → allow (mapped_group)", () => {
    const d = decideAuth({
      fromId: "22222",
      chatId: mappedChatId,
      chatType: "group",
      allowedUserId: OWNER_ID,
      resolveAgent,
    });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toBe("mapped_group");
  });

  test("non-owner in DM → deny (not_owner_dm)", () => {
    const d = decideAuth({
      fromId: "77777",
      chatId: "77777",
      chatType: "private",
      allowedUserId: OWNER_ID,
      resolveAgent,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("not_owner_dm");
  });

  test("non-owner in unmapped group → deny (not_owner_unmapped_group)", () => {
    const d = decideAuth({
      fromId: "33333",
      chatId: unmappedChatId,
      chatType: "supergroup",
      allowedUserId: OWNER_ID,
      resolveAgent,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("not_owner_unmapped_group");
  });

  test("non-owner channel post → deny (not_owner_channel)", () => {
    const d = decideAuth({
      fromId: "44444",
      chatId: "-100777",
      chatType: "channel",
      allowedUserId: OWNER_ID,
      resolveAgent,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("not_owner_channel");
  });

  test("missing fromId → deny (no_from)", () => {
    const d = decideAuth({
      fromId: undefined,
      chatId: mappedChatId,
      chatType: "supergroup",
      allowedUserId: OWNER_ID,
      resolveAgent,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("no_from");
  });
});
