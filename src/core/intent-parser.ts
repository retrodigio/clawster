import { log } from "./logger.ts";

export type Intent =
  | { type: "remember"; content: string }
  | { type: "goal"; content: string; deadline?: string }
  | { type: "done"; content: string };

const REMEMBER_RE = /\[REMEMBER:\s*(.*?)\]/gs;
const GOAL_RE = /\[GOAL:\s*(.*?)(?:\s*\|\s*DEADLINE:\s*(.*?))?\]/gs;
const DONE_RE = /\[DONE:\s*(.*?)\]/gs;

export function parseIntents(response: string): { clean: string; intents: Intent[] } {
  const intents: Intent[] = [];

  for (const match of response.matchAll(REMEMBER_RE)) {
    const content = match[1];
    if (content) intents.push({ type: "remember", content: content.trim() });
  }

  for (const match of response.matchAll(GOAL_RE)) {
    const content = match[1];
    if (!content) continue;
    const intent: Intent = { type: "goal", content: content.trim() };
    const deadline = match[2];
    if (deadline) {
      (intent as Extract<Intent, { type: "goal" }>).deadline = deadline.trim();
    }
    intents.push(intent);
  }

  for (const match of response.matchAll(DONE_RE)) {
    const content = match[1];
    if (content) intents.push({ type: "done", content: content.trim() });
  }

  let clean = response;
  clean = clean.replace(REMEMBER_RE, "");
  clean = clean.replace(GOAL_RE, "");
  clean = clean.replace(DONE_RE, "");
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();

  return { clean, intents };
}

export async function processIntents(intents: Intent[]): Promise<void> {
  for (const intent of intents) {
    if (intent.type === "done") {
      log.info("intents", "Goal completed", { content: intent.content });
      continue;
    }

    const tag = intent.type === "remember" ? "memory" : "goal";
    let text = intent.content;
    if (intent.type === "goal" && intent.deadline) {
      text += ` (deadline: ${intent.deadline})`;
    }

    try {
      const proc = Bun.spawn(["ob", "capture", text, "--source", `intent:${tag}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;

      log.info("intents", `Captured ${intent.type} to Open Brain`, {
        tag,
        content: text.slice(0, 100),
      });
    } catch (err) {
      log.error("intents", `Failed to capture ${intent.type}`, {
        error: String(err),
      });
    }
  }
}
