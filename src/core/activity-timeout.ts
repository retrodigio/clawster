/**
 * Tool-aware activity timeout.
 *
 * Behavior:
 *   - While `toolsInFlight === 0`: inactivity fires after `inactivityMs` of silence.
 *   - While `toolsInFlight > 0`: the effective ceiling becomes `maxMs` (the hard max)
 *     because a long Bash / MCP / subagent Task call legitimately sits silent for
 *     minutes. We still reset on every tool_use/tool_result transition so finishing
 *     a tool re-checks the window.
 *   - `maxMs` is the absolute hard ceiling regardless of state.
 *
 * Matching SDK message shapes:
 *   - `assistant` message with `.message.content[]` containing `{ type: "tool_use", id }`
 *       → tool started, toolsInFlight++
 *   - `user` message with `.message.content[]` containing `{ type: "tool_result", tool_use_id }`
 *       → tool finished, toolsInFlight-- (never below zero)
 *
 * This is the single implementation used both in production (agent-runner wires
 * `onTimeout` to abort the SDK query) and in unit tests.
 */
export function createToolAwareActivityTimeout(options: {
  inactivityMs: number;
  maxMs: number;
  onTimeout: (reason: "inactivity" | "max", info: { elapsedMs: number; toolsInFlight: number }) => void;
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  const { inactivityMs, maxMs, onTimeout } = options;
  const startTime = now();
  let timedOut = false;
  let inactivityTimer: ReturnType<typeof setTimeout>;
  let maxTimer: ReturnType<typeof setTimeout>;
  let toolsInFlight = 0;
  const openToolIds = new Set<string>();

  function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    // While a tool is running, promote the inactivity ceiling up to maxMs so we
    // don't kill a legitimate long-running Bash/MCP/subagent call.
    const ms = toolsInFlight > 0 ? maxMs : inactivityMs;
    inactivityTimer = setTimeout(() => {
      if (timedOut) return;
      timedOut = true;
      onTimeout("inactivity", { elapsedMs: now() - startTime, toolsInFlight });
    }, ms);
  }

  resetInactivityTimer();

  maxTimer = setTimeout(() => {
    if (timedOut) return;
    timedOut = true;
    onTimeout("max", { elapsedMs: now() - startTime, toolsInFlight });
  }, maxMs);

  /**
   * Inspect an SDK message and update toolsInFlight.
   * Returns the delta applied so callers/tests can observe transitions.
   */
  function trackMessage(message: any): number {
    let delta = 0;
    if (!message || typeof message !== "object") return delta;

    // assistant -> tool_use blocks start tools
    if (message.type === "assistant" && message.message?.content) {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === "tool_use") {
            const id = typeof block.id === "string" ? block.id : null;
            if (id) {
              if (!openToolIds.has(id)) {
                openToolIds.add(id);
                toolsInFlight++;
                delta++;
              }
            } else {
              // No id — still count it, best effort
              toolsInFlight++;
              delta++;
            }
          }
        }
      }
    }

    // user -> tool_result blocks end tools
    if (message.type === "user" && message.message?.content) {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === "tool_result") {
            const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
            if (id && openToolIds.has(id)) {
              openToolIds.delete(id);
              if (toolsInFlight > 0) {
                toolsInFlight--;
                delta--;
              }
            } else if (toolsInFlight > 0) {
              // Unknown id but we had something open — decrement best effort
              toolsInFlight--;
              delta--;
            }
          }
        }
      }
    }

    return delta;
  }

  return {
    /** Inspect an SDK message, update tool-tracking state, and reset the timer. */
    observe(message: any) {
      trackMessage(message);
      resetInactivityTimer();
    },
    /** Reset the inactivity timer without inspecting a message. */
    touch() {
      resetInactivityTimer();
    },
    get timedOut() {
      return timedOut;
    },
    get toolsInFlight() {
      return toolsInFlight;
    },
    /** Seconds since the timer was created. */
    get elapsed() {
      return Math.round((now() - startTime) / 1000);
    },
    clear() {
      clearTimeout(inactivityTimer);
      clearTimeout(maxTimer);
    },
  };
}
