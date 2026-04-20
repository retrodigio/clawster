import { toTelegramHtml } from "./telegram-format.ts";
import { log } from "./logger.ts";

const MAX_CHUNK = 4000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_CHUNK) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;
    const searchRegion = remaining.slice(0, MAX_CHUNK);

    // Try splitting at double newline
    const doubleNl = searchRegion.lastIndexOf("\n\n");
    if (doubleNl > 0) {
      splitAt = doubleNl + 2;
    }

    // Fall back to single newline
    if (splitAt === -1) {
      const singleNl = searchRegion.lastIndexOf("\n");
      if (singleNl > 0) {
        splitAt = singleNl + 1;
      }
    }

    // Fall back to space
    if (splitAt === -1) {
      const space = searchRegion.lastIndexOf(" ");
      if (space > 0) {
        splitAt = space + 1;
      }
    }

    // Hard cut as last resort
    if (splitAt === -1) {
      splitAt = MAX_CHUNK;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendResponse(
  ctx: any,
  response: string,
  topicId?: number,
): Promise<void> {
  // Split on safe markdown boundaries (paragraph > line > space) BEFORE
  // rendering. Each chunk is then rendered to Telegram HTML independently;
  // since markdown spans don't cross paragraph boundaries in practice,
  // per-chunk rendering stays well-formed without needing tag balancing.
  const chunks = splitMessage(response);
  const baseOptions: Record<string, any> = topicId
    ? { message_thread_id: topicId }
    : {};

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      await delay(100);
    }
    const markdown = chunks[i]!;
    const html = toTelegramHtml(markdown);
    try {
      await ctx.reply(html, { ...baseOptions, parse_mode: "HTML" });
    } catch (err: any) {
      // Telegram rejects on any malformed HTML. Fall back to plain text so
      // the user still sees the content (raw markdown is better than nothing).
      const desc = err?.description ?? String(err);
      log.warn("send", "HTML parse_mode failed — retrying as plain text", {
        error: desc,
        chunkIndex: i,
      });
      await ctx.reply(markdown, baseOptions);
    }
  }
}
