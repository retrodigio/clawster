/**
 * Discovery mode — logs chat IDs and titles for all incoming messages.
 * Run this, then tap each Telegram group once. Ctrl+C when done.
 *
 * Usage: bun run scripts/discover-chats.ts
 */

import { Bot } from "grammy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "992115973";

if (!BOT_TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const discovered = new Map<string, string>();

bot.use(async (ctx, next) => {
  if (ctx.from?.id.toString() !== ALLOWED_USER_ID) return;
  await next();
});

bot.on("message", (ctx) => {
  const chatId = ctx.chat.id.toString();
  const title = "title" in ctx.chat ? ctx.chat.title : "DM";
  const chatType = ctx.chat.type;

  if (!discovered.has(chatId)) {
    discovered.set(chatId, title ?? "unknown");
    console.log(`\n  "${chatId}": "${title}" (${chatType})`);
    console.log(`  --- ${discovered.size} groups discovered so far ---`);
  }
});

console.log("Discovery mode — send a message in each Telegram group.");
console.log("Press Ctrl+C when done.\n");
console.log("Discovered chats:");

bot.start();

process.on("SIGINT", () => {
  console.log("\n\n=== Final mapping ===\n");
  for (const [id, title] of discovered) {
    console.log(`  "${id}": "${title}",`);
  }
  console.log(`\nTotal: ${discovered.size} chats`);
  process.exit(0);
});
