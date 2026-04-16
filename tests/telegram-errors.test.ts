import { describe, expect, test } from "bun:test";
import { classifyTelegramError } from "../src/core/telegram-errors.ts";

function tgErr(code: number, description: string) {
  return { error_code: code, description };
}

describe("classifyTelegramError", () => {
  test("403 → permanent_chat", () => {
    const got = classifyTelegramError(tgErr(403, "Forbidden: bot was kicked from the supergroup chat"), "sendMessage");
    expect(got.kind).toBe("permanent_chat");
    expect(got.code).toBe(403);
    expect(got.method).toBe("sendMessage");
  });

  test("429 → rate_limit", () => {
    const got = classifyTelegramError(tgErr(429, "Too Many Requests: retry after 17"), "sendMessage");
    expect(got.kind).toBe("rate_limit");
  });

  test("400 'message is not modified' → expected_edit", () => {
    const got = classifyTelegramError(tgErr(400, "Bad Request: message is not modified"), "editMessageText");
    expect(got.kind).toBe("expected_edit");
  });

  test("400 'message to edit not found' → expected_edit", () => {
    const got = classifyTelegramError(tgErr(400, "Bad Request: message to edit not found"), "editMessageText");
    expect(got.kind).toBe("expected_edit");
  });

  test("400 'chat not found' → permanent_chat", () => {
    const got = classifyTelegramError(tgErr(400, "Bad Request: chat not found"), "sendMessage");
    expect(got.kind).toBe("permanent_chat");
  });

  test("400 'group chat was upgraded to a supergroup chat' → permanent_chat", () => {
    const got = classifyTelegramError(
      tgErr(400, "Bad Request: group chat was upgraded to a supergroup chat"),
      "sendMessage",
    );
    expect(got.kind).toBe("permanent_chat");
  });

  test("400 'have no rights to send a message' → permanent_chat", () => {
    const got = classifyTelegramError(
      tgErr(400, "Bad Request: have no rights to send a message"),
      "sendMessage",
    );
    expect(got.kind).toBe("permanent_chat");
  });

  test("400 with unknown description → unknown", () => {
    const got = classifyTelegramError(tgErr(400, "Bad Request: something weird"), "sendMessage");
    expect(got.kind).toBe("unknown");
  });

  test("500 → unknown", () => {
    const got = classifyTelegramError(tgErr(500, "Internal Server Error"), "sendMessage");
    expect(got.kind).toBe("unknown");
  });

  test("matches are case-insensitive", () => {
    const got = classifyTelegramError(tgErr(400, "BAD REQUEST: MESSAGE IS NOT MODIFIED"), "editMessageText");
    expect(got.kind).toBe("expected_edit");
  });

  test("non-object error still classifies safely as unknown", () => {
    const got = classifyTelegramError(new Error("network down"), "sendMessage");
    expect(got.kind).toBe("unknown");
    expect(got.code).toBe(0);
  });
});
