/**
 * Classifies Telegram Bot API errors and returns a handling decision.
 *
 * The grammY `api.config.use` transformer wraps every API call. We use this
 * classifier so we can differentiate between:
 *   - Permanent failures for a chat (kicked, blocked, chat not found) → caller
 *     should unbind the chat from the agent.
 *   - Expected "non-errors" (message not modified, message to edit not found)
 *     that happen during streaming edits → silently succeed.
 *   - Rate limits (429) → let grammY's built-in retry logic run.
 *   - Unknown errors → re-throw so callers can decide.
 */

export type TelegramErrorKind =
  | "permanent_chat" // bot kicked, blocked, chat not found — stop sending to this chat
  | "expected_edit" // "message is not modified" / "message to edit not found"
  | "rate_limit" // 429
  | "unknown";

export interface ClassifiedTelegramError {
  kind: TelegramErrorKind;
  code: number;
  description: string;
  method: string;
}

// Descriptions below are the Telegram Bot API's documented error strings.
// They're stable strings — the API has used these verbatim for years.
const PERMANENT_CHAT_MARKERS = [
  "bot was kicked",
  "bot was blocked",
  "user is deactivated",
  "chat not found",
  "chat_write_forbidden",
  "have no rights to send",
  "bot is not a member",
  "group chat was upgraded to a supergroup chat",
];

const EXPECTED_EDIT_MARKERS = [
  "message is not modified",
  "message to edit not found",
  "message can't be edited",
];

export function classifyTelegramError(err: any, method: string): ClassifiedTelegramError {
  const code = typeof err?.error_code === "number" ? err.error_code : 0;
  const description = typeof err?.description === "string" ? err.description : String(err);
  const lower = description.toLowerCase();

  if (code === 429) {
    return { kind: "rate_limit", code, description, method };
  }

  if (code === 403) {
    return { kind: "permanent_chat", code, description, method };
  }

  if (code === 400) {
    if (EXPECTED_EDIT_MARKERS.some((m) => lower.includes(m))) {
      return { kind: "expected_edit", code, description, method };
    }
    if (PERMANENT_CHAT_MARKERS.some((m) => lower.includes(m))) {
      return { kind: "permanent_chat", code, description, method };
    }
  }

  return { kind: "unknown", code, description, method };
}
