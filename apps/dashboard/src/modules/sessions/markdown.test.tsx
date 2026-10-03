import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.js";

const html = (text: string) =>
  renderToStaticMarkup(<Markdown text={text} />)
    .replace(/^<div class="message-text">/u, "")
    .replace(/<\/div>$/u, "");

it("renders inline marks, nested and side by side, and leaves plain words alone", () => {
  expect(html("Use **bold** and *italic* or __strong__ and _em_.")).toBe(
    "<p>Use <strong>bold</strong> and <em>italic</em> or <strong>strong</strong> and <em>em</em>.</p>",
  );
  expect(html("**a `b` c** ~~old *x*~~ `**raw**`")).toBe(
    "<p><strong>a <code>b</code> c</strong> <s>old <em>x</em></s> <code>**raw**</code></p>",
  );
  // Underscores inside identifiers and lone stars are not emphasis.
  expect(html("snake_case_name, 2 * 3 * 4 and * x *")).toBe(
    "<p>snake_case_name, 2 * 3 * 4 and * x *</p>",
  );
  expect(html("*a*b")).toBe("<p><em>a</em>b</p>");
  expect(html("*ab c*")).toBe("<p><em>ab c</em></p>");
  expect(html("_ab c_")).toBe("<p><em>ab c</em></p>");
  expect(html("`a`")).toBe("<p><code>a</code></p>");
});

it("keeps links as readable text and never interprets HTML", () => {
  expect(html("See [docs](https://example.test/a) now")).toBe(
    "<p>See docs (https://example.test/a) now</p>",
  );
  expect(html('<img src=x onerror="bad()"> [x](javascript:bad())')).toBe(
    "<p>&lt;img src=x onerror=&quot;bad()&quot;&gt; x (javascript:bad())</p>",
  );
});

it("groups lines into paragraphs, headings, rules, quotes and lists", () => {
  expect(html("one\ntwo\n\nthree")).toBe("<p>one\ntwo</p><p>three</p>");
  expect(html("# Title\n### **Sub**")).toBe("<h4>Title</h4><h4><strong>Sub</strong></h4>");
  expect(html("before\n---\n***\n___\nafter")).toBe("<p>before</p><hr/><hr/><hr/><p>after</p>");
  expect(html("> quoted\n>more\n\n> - item")).toBe(
    "<blockquote><p>quoted\nmore</p></blockquote><blockquote><ul><li>item</li></ul></blockquote>",
  );
  expect(html("- a\n* **b**\n+ c\ntext")).toBe(
    "<ul><li>a</li><li><strong>b</strong></li><li>c</li></ul><p>text</p>",
  );
  expect(html("3. three\n4) four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  expect(html("  - indented")).toBe("<ul><li>indented</li></ul>");
  // A paragraph ends where another block starts, without a blank line.
  expect(html("intro\n# h\nintro\n- i\nintro\n> q\nintro\n---\nintro\n```\nc\n```")).toBe(
    "<p>intro</p><h4>h</h4><p>intro</p><ul><li>i</li></ul><p>intro</p><blockquote><p>q</p></blockquote>" +
      "<p>intro</p><hr/><p>intro</p><pre><code>c</code></pre>",
  );
  expect(html("#nospace -nolist 1.nolist")).toBe("<p>#nospace -nolist 1.nolist</p>");
  // Whitespace-only lines separate paragraphs; list kind comes from the marker, not the text.
  expect(html("a\n   \nb")).toBe("<p>a</p><p>b</p>");
  expect(html("- item 2\n  1. x")).toBe("<ul><li>item 2</li><li>x</li></ul>");
  expect(html("  1. x")).toBe('<ol start="1"><li>x</li></ol>');
  expect(html("intro\n  ```\ncode")).toBe("<p>intro</p><pre><code>code</code></pre>");
});

it("renders closed, indented and unfinished fences verbatim", () => {
  expect(html("```ts\nconst a = **b**;\n\n<i>x</i>\n```\nafter")).toBe(
    "<pre><code>const a = **b**;\n\n&lt;i&gt;x&lt;/i&gt;</code></pre><p>after</p>",
  );
  expect(html("  ```\nkept\n  ```")).toBe("<pre><code>kept</code></pre>");
  // Only a line that starts with a fence closes it.
  expect(html("```\ncode ```\n```")).toBe("<pre><code>code ```</code></pre>");
  expect(html("```\nstreaming")).toBe("<pre><code>streaming</code></pre>");
  expect(html("")).toBe("");
  expect(html("\n\n")).toBe("");
});
