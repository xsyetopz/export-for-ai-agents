import { expect, test } from "bun:test";
import { micromark } from "micromark";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";
import type { ExportDocument } from "../src/model.ts";
import { toJsonl } from "../src/serialize/jsonl.ts";
import {
  escapeMarkdown,
  toMarkdown,
  yamlScalar,
} from "../src/serialize/markdown.ts";
import { createValidator, validateJsonl } from "../tools/schema-validator.ts";
import { articleDoc, threadDoc } from "./fixtures/documents.ts";

const withBlocks = (
  blocks: ExportDocument["blocks"],
  title = "T",
): ExportDocument => ({
  meta: { ...threadDoc.meta, title },
  blocks,
});

test("front matter quotes untrusted scalars", () => {
  const md = toMarkdown(withBlocks([], 'a: b # c "q"\nline2 --- \u2028'));
  const fm = md.split("---\n")[1] ?? "";
  expect(fm).toContain('title: "a: b # c \\"q\\"\\nline2 --- \\u2028"');
  expect(md.startsWith("---\n")).toBe(true);
  expect(yamlScalar("yes")).toBe('"yes"');
});

test("title, description and body layout", () => {
  const md = toMarkdown(articleDoc);
  expect(md).toContain("\n# Hello: a #title\n");
  expect(md).toContain("\n> Short description\n");
  expect(md).toContain('coverage:\n  "blocks": 9\n  "partial": false');
  expect(md).toContain('content_trust: "untrusted"');
  expect(md.endsWith("\n")).toBe(true);
});

test("escapes markdown syntax in plain text", () => {
  expect(escapeMarkdown("# h\n- x\n1. y\n> q")).toBe(
    "\\# h\n\\- x\n1\\. y\n\\> q",
  );
  expect(escapeMarkdown("a *b* [c](d) `e` <f>")).toBe(
    "a \\*b\\* \\[c\\](d) \\`e\\` \\<f\\>",
  );
});

test("code fences outgrow backtick runs", () => {
  const md = toMarkdown(
    withBlocks([{ type: "code", language: "ts x", text: "a ```` b\n" }]),
  );
  expect(md).toContain("`````tsx\na ```` b\n`````");
});

test("tables escape pipes and newlines", () => {
  const md = toMarkdown(articleDoc);
  expect(md).toContain("| a | b |\n| --- | --- |\n| 1\\|2 | x<br>y |");
});

test("media become links and unsafe schemes are dropped", () => {
  const md = toMarkdown(
    withBlocks([
      {
        type: "media",
        kind: "video",
        url: "https://e.com/a b.mp4",
        alt: "clip",
      },
      { type: "link", url: "javascript:alert(1)", text: "bad" },
    ]),
  );
  expect(md).toContain("[Video: clip](https://e.com/a%20b.mp4)");
  expect(md).not.toContain("javascript");
  expect(toMarkdown(articleDoc)).toContain(
    "[Image: pic](https://example.com/i.png)",
  );
  expect(toMarkdown(articleDoc)).toContain("(https://example.com/%28x%29)");
});

test("thread header and reply nesting", () => {
  const md = toMarkdown(threadDoc);
  expect(md).toContain("**u1** · 3 · 2026-09-22 · `t1_a`");
  expect(md).toContain("> **u2** · `t1_b`\n>\n> reply");
  expect(md).toContain("*Accepted answer*");
});

test("nesting capped at 6 levels, deeper flattened with reply to", () => {
  const md = toMarkdown(
    withBlocks([
      { type: "comment", id: "c9", parent_id: "c8", depth: 9, body: "deep" },
    ]),
  );
  expect(md).toContain("> > > > > > `c9`");
  expect(md).not.toContain("> > > > > > > ");
  expect(md).toContain("reply to `c8`");
});

test("jsonl: header first, one object per line, LF only", () => {
  const out = toJsonl(threadDoc);
  const lines = out.split("\n");
  expect(lines.at(-1)).toBe("");
  expect(lines.length).toBe(threadDoc.blocks.length + 2);
  const header = JSON.parse(lines[0] ?? "");
  expect(Object.keys(header)[0]).toBe("$schema");
  expect(header.type).toBe("document");
  expect(out).not.toContain("\r");
});

test("jsonl escapes U+2028/2029", () => {
  const out = toJsonl(
    withBlocks([{ type: "paragraph", text: "a\u2028b\u2029c" }]),
  );
  expect(out).not.toMatch(/[\u2028\u2029]/);
  expect(JSON.parse(out.split("\n")[1] ?? "").text).toBe("a\u2028b\u2029c");
});

test("fixture jsonl validates against schema", () => {
  expect(validateJsonl(toJsonl(articleDoc))).toEqual([]);
  expect(validateJsonl(toJsonl(threadDoc))).toEqual([]);
});

test("schema rejects bad lines", () => {
  const validate = createValidator();
  expect(validate({ type: "heading", level: 7, text: "x" })).toBe(false);
  expect(validate({ type: "nope" })).toBe(false);
  expect(validate({ type: "paragraph", text: "x", extra: 1 })).toBe(false);
  expect(
    validate({ type: "comment", id: "a", parent_id: null, depth: 0 }),
  ).toBe(true);
});

// Rendered-structure regressions (micromark).
const html = (blocks: ExportDocument["blocks"], title = "T"): string => {
  const md = toMarkdown(withBlocks(blocks, title)).replace(
    /^---\n[\s\S]*?\n---\n/,
    "",
  );
  return micromark(md, {
    extensions: [gfmTable()],
    htmlExtensions: [gfmTableHtml()],
  });
};

test("bare CR cannot escape quotes, lists or thread nesting", () => {
  const attack = "x\r# INJECT";
  const q = html([{ type: "quote", blocks: [{ type: "code", text: attack }] }]);
  expect(q).not.toContain("<h1>INJECT");
  const l = html([
    { type: "list", ordered: false, items: [{ type: "item", text: attack }] },
  ]);
  expect(l).not.toContain("<h1>INJECT");
  const c = html([
    {
      type: "comment",
      id: "c",
      parent_id: "p",
      depth: 1,
      content: [{ type: "code", text: attack }],
    },
  ]);
  expect(c).not.toContain("<h1>INJECT");
  expect(html([{ type: "paragraph", text: "a\u2028# no" }])).toContain(
    "<p>a\n# no</p>",
  );
});

test("links use a scheme allowlist, entities included", () => {
  for (const url of [
    "javascript:alert(1)",
    "JaVa\tScript:alert(1)",
    "javascript&#58;alert(1)",
    "javascript&colon;alert(1)",
    "data:text/html,x",
  ]) {
    const out = html([{ type: "link", url, text: "x" }]);
    expect(out).not.toMatch(/href="[^"]*(javascript|data:)/i);
    expect(out).not.toContain("<a");
  }
  expect(
    html([{ type: "link", url: 'https://e.com/a?b=1&c="2"', text: "ok" }]),
  ).toContain('href="https://e.com/a?b=1%26c=%222%22"');
  expect(html([{ type: "link", url: "mailto:a@b.c", text: "m" }])).toContain(
    "<a",
  );
  expect(html([{ type: "link", url: "/rel/path", text: "r" }])).toContain(
    'href="/rel/path"',
  );
});

test("table cells starting with a pipe, empty headers, extra cells", () => {
  expect(
    html([{ type: "table", header: ["|a", "b"], rows: [["c", "d"]] }]),
  ).toContain("<th>|a</th>");
  const empty = html([{ type: "table", header: [], rows: [["r1", "r2"]] }]);
  expect(empty).toContain("<table>");
  expect(empty).toContain("r2");
  const extra = html([{ type: "table", header: ["a"], rows: [["1", "2"]] }]);
  expect(extra).toContain("<td>2</td>");
});

test("native bodies cannot swallow later content", () => {
  for (const body of ["```\nopen", "<!-- open", "<pre>open", "~~~js\nx"]) {
    const out = html([
      { type: "comment", id: "a", parent_id: null, depth: 0, body },
      { type: "heading", level: 2, text: "After" },
    ]);
    expect(out).toContain("<h2>After</h2>");
  }
});

test("leading whitespace cannot create indented code", () => {
  expect(html([{ type: "paragraph", text: "\t    code?" }])).not.toContain(
    "<pre>",
  );
  expect(
    html([
      {
        type: "list",
        ordered: false,
        items: [{ type: "item", text: "        deep" }],
      },
    ]),
  ).not.toContain("<pre>");
});

test("trailing # in headings survives", () => {
  expect(html([{ type: "heading", level: 2, text: "C #" }])).toContain(
    "<h2>C #</h2>",
  );
  expect(html([], "C ##")).toContain("<h1>C ##</h1>");
});

test("yaml keys are always quoted", () => {
  const doc = withBlocks([]);
  doc.meta.coverage = { null: 1, yes: 2 };
  const md = toMarkdown(doc);
  expect(md).toContain('  "null": 1');
  expect(md).toContain('  "yes": 2');
});

test("empty id yields no code span", () => {
  const out = toMarkdown(
    withBlocks([
      {
        type: "comment",
        id: " ",
        parent_id: null,
        author: "a",
        depth: 0,
        body: "x",
      },
    ]),
  );
  expect(out).not.toContain("``");
});

test("content blocks carry optional ids into JSONL and validate", () => {
  const doc = withBlocks([{ type: "paragraph", id: "b1", text: "x" }]);
  expect(JSON.parse(toJsonl(doc).split("\n")[1] ?? "").id).toBe("b1");
  expect(validateJsonl(toJsonl(doc))).toEqual([]);
});
