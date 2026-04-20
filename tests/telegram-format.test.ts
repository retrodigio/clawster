import { describe, expect, test } from "bun:test";
import { toTelegramHtml, toTelegramHtmlPartial } from "../src/core/telegram-format.ts";

describe("toTelegramHtml", () => {
  test("empty / plain", () => {
    expect(toTelegramHtml("")).toBe("");
    expect(toTelegramHtml("hello world")).toBe("hello world");
  });

  test("bold + italic", () => {
    expect(toTelegramHtml("**bold**")).toBe("<b>bold</b>");
    expect(toTelegramHtml("*italic*")).toBe("<i>italic</i>");
    expect(toTelegramHtml("_italic_")).toBe("<i>italic</i>");
    expect(toTelegramHtml("__bold__")).toBe("<b>bold</b>");
  });

  test("strikethrough", () => {
    expect(toTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
  });

  test("inline code escapes content", () => {
    expect(toTelegramHtml("use `<div>`")).toBe("use <code>&lt;div&gt;</code>");
  });

  test("fenced code block with language", () => {
    const out = toTelegramHtml("```ts\nconst x = 1;\n```");
    expect(out).toBe('<pre><code class="language-ts">const x = 1;</code></pre>');
  });

  test("fenced code block without language", () => {
    const out = toTelegramHtml("```\nraw\n```");
    expect(out).toBe("<pre>raw</pre>");
  });

  test("headings become bold", () => {
    expect(toTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(toTelegramHtml("### Sub")).toBe("<b>Sub</b>");
  });

  test("bullet list renders as • with preserved indent", () => {
    const md = "- one\n- two";
    expect(toTelegramHtml(md)).toBe("• one\n• two");
  });

  test("links", () => {
    expect(toTelegramHtml("[google](https://google.com)")).toBe(
      '<a href="https://google.com">google</a>',
    );
  });

  test("blockquote merges consecutive lines", () => {
    const md = "> first line\n> second line";
    expect(toTelegramHtml(md)).toBe(
      "<blockquote>first line\nsecond line</blockquote>\n",
    );
  });

  test("HTML special chars are escaped outside code", () => {
    expect(toTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  test("code-fence content does not get markdown-rewritten", () => {
    const md = "```\n**not bold**\n```";
    expect(toTelegramHtml(md)).toBe("<pre>**not bold**</pre>");
  });

  test("does not italic-wrap snake_case identifiers", () => {
    // `foo_bar_baz` in prose shouldn't become `foo<i>bar</i>baz`.
    expect(toTelegramHtml("using foo_bar_baz here")).toBe("using foo_bar_baz here");
  });

  // --- Tier 2: partial / streaming cases ---

  test("partial: plain text unchanged", () => {
    expect(toTelegramHtmlPartial("hello world")).toBe("hello world");
  });

  test("partial: unclosed ** stays literal (valid HTML)", () => {
    // Tokens can land mid-span — the inline regex won't match, so ** stays
    // as literal text. Telegram HTML parser accepts this.
    expect(toTelegramHtmlPartial("hello **bo")).toBe("hello **bo");
  });

  test("partial: unclosed inline code stays literal", () => {
    expect(toTelegramHtmlPartial("use `foo")).toBe("use `foo");
  });

  test("partial: completed bold mid-stream renders", () => {
    // Once the closing delimiter arrives, the span formats.
    expect(toTelegramHtmlPartial("say **hi** there")).toBe("say <b>hi</b> there");
  });

  test("partial: unterminated code fence renders as partial <pre>", () => {
    const out = toTelegramHtmlPartial("```py\ndef foo");
    expect(out).toBe('<pre><code class="language-py">def foo</code></pre>');
  });

  test("partial: unterminated fence after stable prose", () => {
    const out = toTelegramHtmlPartial("Here's the code:\n\n```ts\nconst x =");
    expect(out).toContain("Here&#x27;s".replace(/&#x27;/g, "'") || "Here's");
    expect(out).toContain('<pre><code class="language-ts">const x =</code></pre>');
  });

  test("partial: unterminated fence without language", () => {
    const out = toTelegramHtmlPartial("```\nraw in progress");
    expect(out).toBe("<pre>raw in progress</pre>");
  });

  test("partial: terminated fence behaves like full render", () => {
    const md = "```ts\nconst x = 1;\n```";
    expect(toTelegramHtmlPartial(md)).toBe(toTelegramHtml(md));
  });

  test("partial: escapes HTML-sensitive chars in partial fence", () => {
    const out = toTelegramHtmlPartial("```\nif (a<b) {");
    expect(out).toBe("<pre>if (a&lt;b) {</pre>");
  });

  test("realistic mixed message", () => {
    const md = [
      "# Status",
      "",
      "All **three** fixes shipped:",
      "- `fb1a6e1` — inter-agent comms",
      "- `fe3060c` — stall message",
      "",
      "Run `clawster status` to check.",
    ].join("\n");
    const out = toTelegramHtml(md);
    expect(out).toContain("<b>Status</b>");
    expect(out).toContain("<b>three</b>");
    expect(out).toContain("• <code>fb1a6e1</code>");
    expect(out).toContain("<code>clawster status</code>");
  });
});
