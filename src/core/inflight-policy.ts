/**
 * Classifies how to handle a new user message that arrives while an agent's
 * prior turn is still in flight.
 *
 * Two outcomes:
 *   - "interrupt" — abort the in-flight turn and process the new message now.
 *                   Used for corrections like "wait, I meant X" or explicit
 *                   overrides.
 *   - "queue"     — wait for the in-flight turn to finish, then process the
 *                   new message (FIFO). Default for normal conversational
 *                   messages.
 *
 * The classifier is deliberately biased toward "queue": it's recoverable if
 * we queue when the user wanted to interrupt (just send another message).
 * It's worse to interrupt when the user wanted to queue, because prior work
 * gets thrown away.
 *
 * This mirrors Claude Code's own default behavior (messages queue during
 * generation, Esc explicitly interrupts).
 */

export type InflightIntent = "interrupt" | "queue";

/**
 * Leading tokens / phrases that signal the user wants to abort the current
 * turn and start fresh. Match is case-insensitive and requires the phrase to
 * appear at the start of the message (possibly after an initial punctuation).
 */
const INTERRUPT_LEADERS = [
  "wait",
  "stop",
  "cancel",
  "hold on",
  "hold up",
  "nevermind",
  "never mind",
  "scratch that",
  "disregard",
  "actually",
  "forget that",
  "forget it",
  "abort",
];

export function classifyInflightIntent(text: string): InflightIntent {
  if (!text) return "queue";
  const trimmed = text.trim();
  if (!trimmed) return "queue";

  // Explicit override: leading "!" means "do this now, interrupt anything in
  // progress." Easy to type, unambiguous, no natural-language collisions.
  if (trimmed.startsWith("!")) return "interrupt";

  // Normalize: lowercase, strip leading punctuation so "...wait" still matches.
  const normalized = trimmed.toLowerCase().replace(/^[^\p{L}\p{N}!]+/u, "");

  for (const leader of INTERRUPT_LEADERS) {
    if (normalized === leader) return "interrupt";
    if (normalized.startsWith(leader)) {
      // Require a word boundary after the leader so "waitress" doesn't match
      // "wait". Allow whitespace, punctuation, or end-of-string.
      const next = normalized[leader.length];
      if (next === undefined || /[\s,.!?:;]/.test(next)) {
        return "interrupt";
      }
    }
  }

  return "queue";
}
