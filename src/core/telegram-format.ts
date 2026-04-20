/**
 * Convert Markdown (as produced by Claude) into the restricted HTML subset
 * Telegram accepts with `parse_mode: "HTML"`.
 *
 * Telegram-supported tags: b, i, u, s, code, pre, a, blockquote, span (spoiler).
 * Any unknown tag makes the whole send fail — callers MUST have a plain-text
 * fallback path if rendering somehow produces invalid markup.
 *
 * Strategy:
 *   1. Extract fenced + inline code first (with placeholders) so their
 *      contents are shielded from further rewriting.
 *   2. HTML-escape everything else (& < >).
 *   3. Apply block-level transforms line-by-line (headings, bullets, rules,
 *      blockquotes).
 *   4. Apply inline transforms (bold, italic, strike, links).
 *   5. Re-insert the code placeholders.
 */

const PLACEHOLDER_FENCE = "\x00FENCE";
const PLACEHOLDER_INLINE = "\x00INLINE";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Variant for mid-stream / partial markdown (Tier 2 streaming).
 *
 * Claude's tokens often land mid-span: `"hello **bo"` at one tick, `"ld**"`
 * at the next. Most unclosed spans are already safe because the inline regex
 * in `toTelegramHtml` requires matched delimiters — they just remain literal
 * text until the closing delimiter arrives. The one case worth special-casing
 * is a fenced code block in progress: we want the user to see code growing
 * inside a <pre> block, not plain text with a trailing "```py" prefix.
 *
 * This wrapper detects an unterminated trailing fence, splits the input at
 * its opening, renders the stable prefix normally, and emits the in-progress
 * content as a partial <pre> block.
 */
export function toTelegramHtmlPartial(markdown: string): string {
  if (!markdown) return "";

  // Count fence markers. If odd → the last fence is unterminated.
  const fenceMatches = [...markdown.matchAll(/```([a-zA-Z0-9_+\-]*)\n?/g)];
  const unterminated = fenceMatches.length % 2 === 1 ? fenceMatches.at(-1) : undefined;

  if (unterminated) {
    const fenceStart = unterminated.index ?? 0;
    const lang = unterminated[1] ?? "";
    const fenceTokenLen = unterminated[0].length;
    const stablePrefix = markdown.slice(0, fenceStart);
    const partialContent = markdown.slice(fenceStart + fenceTokenLen);
    const rendered = toTelegramHtml(stablePrefix);
    const escapedContent = partialContent
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const partialPre = lang
      ? `<pre><code class="language-${lang.replace(/[^a-zA-Z0-9_+\-]/g, "")}">${escapedContent}</code></pre>`
      : `<pre>${escapedContent}</pre>`;
    // Separator: preserve the newline/paragraph boundary the stable prefix
    // ended with (or just concatenate if it already ended in whitespace).
    const sep = /[\n]$/.test(rendered) || rendered.length === 0 ? "" : "\n";
    return `${rendered}${sep}${partialPre}`;
  }

  // No unterminated fence — the regex boundaries in toTelegramHtml already
  // leave unclosed inline spans (**, *, _, `, ~~, [, etc.) as literal text,
  // which is valid HTML, so a plain call is safe.
  return toTelegramHtml(markdown);
}

export function toTelegramHtml(markdown: string): string {
  if (!markdown) return "";

  const fences: string[] = [];
  const inlines: string[] = [];

  // 1a. Fenced code blocks: ```lang\n...\n```
  // Require a closing fence; unclosed fences fall through and become plain text
  // (safer than pretending they're complete code).
  let s = markdown.replace(
    /```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const idx = fences.length;
      const escaped = escapeHtml(code.replace(/\n$/, ""));
      const html = lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`;
      fences.push(html);
      return `${PLACEHOLDER_FENCE}${idx}\x00`;
    },
  );

  // 1b. Inline code: `...`
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlines.length;
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `${PLACEHOLDER_INLINE}${idx}\x00`;
  });

  // 2. Escape raw HTML in the remaining content.
  s = escapeHtml(s);

  // 3. Block-level transforms (line by line).
  const lines = s.split("\n");
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine;

    // Heading: # .. ######  →  <b>text</b>
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      out.push(`<b>${heading[2]}</b>`);
      continue;
    }

    // Horizontal rule: --- | *** | ___
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("─────────");
      continue;
    }

    // Bullet list: - item  *  item  + item  →  "• item" (indent preserved)
    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      out.push(`${bullet[1]}• ${bullet[2]}`);
      continue;
    }

    // Blockquote: > text  →  <blockquote>text</blockquote>
    // (Consecutive blockquotes merged in a second pass below.)
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (bq) {
      out.push(`<blockquote>${bq[1]}</blockquote>`);
      continue;
    }

    out.push(line);
  }
  s = out.join("\n");

  // Merge runs of <blockquote>...</blockquote> lines into a single block so
  // Telegram renders them as one quote rather than N tiny quotes.
  s = s.replace(
    /(?:<blockquote>[^\n]*<\/blockquote>(?:\n|$))+/g,
    (block) => {
      const inner = block
        .trim()
        .split("\n")
        .map((l) => l.replace(/^<blockquote>/, "").replace(/<\/blockquote>$/, ""))
        .join("\n");
      return `<blockquote>${inner}</blockquote>\n`;
    },
  );

  // 4. Inline transforms.

  // Bold: **text** and __text__  →  <b>text</b>
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])__([^\n_]+?)__(?=$|[\s).,!?:;])/g, "$1<b>$2</b>");

  // Italic: *text* and _text_ (single-delim, not part of bold)
  s = s.replace(/(^|[\s(])\*([^\s*][^*\n]*?[^\s*]|\S)\*(?=$|[\s).,!?:;])/g, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])_([^\s_][^_\n]*?[^\s_]|\S)_(?=$|[\s).,!?:;])/g, "$1<i>$2</i>");

  // Strikethrough: ~~text~~  →  <s>text</s>
  s = s.replace(/~~([^\n~]+?)~~/g, "<s>$1</s>");

  // Links: [text](url)
  // `text` and `url` at this point have already been HTML-escaped, which is
  // fine for both tag content and href attribute values. We additionally
  // escape `"` inside the URL to keep the attribute well-formed.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const safeUrl = url.replace(/"/g, "&quot;");
    return `<a href="${safeUrl}">${text}</a>`;
  });

  // 5. Restore code placeholders.
  s = s.replace(
    new RegExp(`${PLACEHOLDER_INLINE}(\\d+)\\x00`, "g"),
    (_, idx) => inlines[Number(idx)]!,
  );
  s = s.replace(
    new RegExp(`${PLACEHOLDER_FENCE}(\\d+)\\x00`, "g"),
    (_, idx) => fences[Number(idx)]!,
  );

  return s;
}
