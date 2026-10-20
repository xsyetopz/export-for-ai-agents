import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { githubAdapter } from "../src/adapters/github.ts";
import { hackerNewsAdapter } from "../src/adapters/hackernews.ts";
import { selectAdapter } from "../src/adapters/index.ts";
import { stackExchangeAdapter } from "../src/adapters/stackexchange.ts";
import {
  type Adapter,
  CaptureAbortedError,
  isNotThisLayout,
} from "../src/adapters/types.ts";
import type { Block, ExportDocument } from "../src/model.ts";
import { toJsonl } from "../src/serialize/jsonl.ts";
import { toMarkdown } from "../src/serialize/markdown.ts";
import { validateJsonl } from "../tools/schema-validator.ts";

const windows: Window[] = [];
afterEach(() => {
  for (const w of windows.splice(0)) w.happyDOM.close();
});

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

async function run(
  adapter: Adapter,
  url: string,
  html: string,
  signal?: AbortSignal,
): Promise<ExportDocument> {
  const win = new Window({ url });
  windows.push(win);
  win.document.body.innerHTML = html;
  const doc = await adapter.capture({
    document: win.document as unknown as Document,
    url,
    options: {},
    ...(signal ? { signal } : {}),
  });
  expect(validateJsonl(toJsonl(doc))).toEqual([]);
  expect(toMarkdown(doc)).toContain("content_trust");
  return doc;
}

const find = (doc: ExportDocument, id: string): Block => {
  const block = doc.blocks.find((b) => "id" in b && b.id === id);
  if (!block) throw new Error(`no block ${id}`);
  return block;
};

const matchCases = (adapter: Adapter, yes: string[], no: string[]) => {
  for (const url of yes)
    expect([url, adapter.matches(url)]).toEqual([url, true]);
  for (const url of no)
    expect([url, adapter.matches(url)]).toEqual([url, false]);
};

test("hackernews matches only item pages", () => {
  matchCases(
    hackerNewsAdapter,
    ["https://news.ycombinator.com/item?id=4001"],
    [
      "https://news.ycombinator.com/",
      "https://news.ycombinator.com/item",
      "https://news.ycombinator.com/item?id=abc",
      "http://news.ycombinator.com/item?id=1",
      "https://evil.example/item?id=1",
      "not a url",
    ],
  );
  expect(selectAdapter("https://news.ycombinator.com/item?id=1").id).toBe(
    "hackernews",
  );
});

test("hackernews derives parents and depth from indent", async () => {
  const doc = await run(
    hackerNewsAdapter,
    "https://news.ycombinator.com/item?id=4001",
    await fixture("hackernews-item.html"),
  );
  expect(doc.meta).toMatchObject({
    adapter: "hackernews",
    title: "Show HN: A tiny exporter",
    author: "alice",
    published: "2026-10-19T10:00:00Z",
    content_trust: "untrusted",
  });
  expect(doc.meta.coverage).toMatchObject({
    comments_captured: 4,
    comments_unavailable: 1,
    comments_reported: 3,
    partial: false,
  });
  const post = find(doc, "4001");
  expect(post).toMatchObject({ type: "post", score: 142, parent_id: null });
  const edges = doc.blocks
    .filter((b) => b.type === "comment")
    .map((b) => (b.type === "comment" ? [b.id, b.parent_id, b.depth] : []));
  expect(edges).toEqual([
    ["4002", "4001", 0],
    ["4003", "4002", 1],
    ["4004", "4003", 2],
    ["4005", "4001", 0],
    ["4006", "4005", 1],
  ]);
  expect(find(doc, "4006")).toMatchObject({
    content: [{ type: "paragraph", text: "[deleted]" }],
  });
  expect("author" in find(doc, "4006")).toBe(false);
  expect(find(doc, "4003")).toMatchObject({ author: "carol" });
  const md = toMarkdown(doc);
  expect(md).toContain("https://example.org/post?a=1");
  expect(md).toContain("Second paragraph.");
  expect(md).toContain("Top level comment.");
  expect(md).not.toContain("reply?id");
  expect(doc.meta.warnings?.join(" ")).toContain("1 comment(s)");
});

test("hackernews without a story is not this layout", async () => {
  const error = await run(
    hackerNewsAdapter,
    "https://news.ycombinator.com/item?id=1",
    "<p>No such item.</p>",
  ).catch((e: unknown) => e);
  expect(isNotThisLayout(error)).toBe(true);
});

test("github matches issues, pulls and discussions only", () => {
  matchCases(
    githubAdapter,
    [
      "https://github.com/o/r/issues/42",
      "https://github.com/o/r/pull/7/",
      "https://github.com/o/r/discussions/3",
    ],
    [
      "https://github.com/o/r",
      "https://github.com/o/r/blob/main/README.md",
      "https://github.com/o/r/issues",
      "https://github.com/o/r/issues/new",
      "https://github.com/o/r/pull/7/files",
      "https://gist.github.com/o/r/issues/1",
      "https://example.com/o/r/issues/1",
    ],
  );
  expect(selectAdapter("https://github.com/o/r").id).toBe("generic");
  expect(selectAdapter("https://github.com/o/r/issues/42").id).toBe("github");
});

test("github issue maps body, timeline comments, authors and dates", async () => {
  const doc = await run(
    githubAdapter,
    "https://github.com/o/r/issues/42",
    await fixture("github-issue.html"),
  );
  expect(doc.meta).toMatchObject({
    adapter: "github",
    title: "Crash when exporting empty page",
    author: "octo",
    published: "2026-10-01T08:30:00Z",
  });
  expect(doc.meta.coverage).toMatchObject({
    kind: "issues",
    comments_captured: 2,
    state: "Open",
  });
  expect(doc.blocks.map((b) => b.type)).toEqual(["post", "comment", "comment"]);
  expect(find(doc, "issue-9001")).toMatchObject({
    type: "post",
    parent_id: null,
    depth: 0,
  });
  expect(find(doc, "issuecomment-9002")).toMatchObject({
    type: "comment",
    author: "maint",
    parent_id: "issue-9001",
    depth: 0,
    date: "2026-10-02T09:00:00Z",
  });
  const md = toMarkdown(doc);
  expect(md).toContain("Steps to reproduce:");
  expect(md).toContain("https://example.org/trace");
  expect(md).toContain('throw new Error("boom")');
  expect(md).not.toContain("Label");
});

test("github page without timeline markup falls back via not-this-layout", async () => {
  const error = await run(
    githubAdapter,
    "https://github.com/o/r/issues/42",
    "<div id='react-root'>loading</div>",
  ).catch((e: unknown) => e);
  expect(isNotThisLayout(error)).toBe(true);
});

test("stackexchange matches the network's question pages", () => {
  matchCases(
    stackExchangeAdapter,
    [
      "https://stackoverflow.com/questions/5001/how-do-i-sort",
      "https://superuser.com/questions/1/x",
      "https://serverfault.com/questions/1/x",
      "https://askubuntu.com/questions/1/x",
      "https://mathoverflow.net/questions/1/x",
      "https://stackapps.com/questions/1/x",
      "https://math.stackexchange.com/questions/1/x",
      "https://ru.stackoverflow.com/questions/1/x",
    ],
    [
      "https://stackoverflow.com/",
      "https://stackoverflow.com/questions",
      "https://stackoverflow.com/questions/tagged/python",
      "https://stackoverflow.com/users/1/x",
      "https://notstackoverflow.com/questions/1/x",
      "https://stackoverflow.com.evil.example/questions/1/x",
      "http://stackoverflow.com/questions/1/x",
    ],
  );
  expect(selectAdapter("https://stackoverflow.com/questions/1/x").id).toBe(
    "stackexchange",
  );
});

test("stackexchange captures question, tags, accepted answer and comments", async () => {
  const doc = await run(
    stackExchangeAdapter,
    "https://stackoverflow.com/questions/5001/how-do-i-sort",
    await fixture("stackexchange-question.html"),
  );
  expect(doc.meta).toMatchObject({
    adapter: "stackexchange",
    title: "How do I sort a list in place?",
    site: "stackoverflow.com",
    author: "asker",
    published: "2026-10-10T09:00:00Z",
  });
  expect(doc.meta.coverage).toMatchObject({
    answers_captured: 2,
    accepted_answers: 1,
    comments_captured: 2,
    tags: 2,
    partial: false,
  });
  expect(find(doc, "q5001")).toMatchObject({
    type: "post",
    score: 12,
    parent_id: null,
  });
  expect(find(doc, "a5002")).toMatchObject({
    type: "answer",
    accepted: true,
    score: 25,
    author: "guru",
    parent_id: "q5001",
    date: "2026-10-10T10:00:00Z",
  });
  const second = find(doc, "a5003");
  expect(second).toMatchObject({ type: "answer", score: -1, author: "other" });
  expect("accepted" in second).toBe(false);
  expect(find(doc, "c7001")).toMatchObject({
    type: "comment",
    parent_id: "q5001",
    depth: 0,
    author: "helper",
    score: 2,
    date: "2026-10-10T09:30:00Z",
  });
  expect(find(doc, "c7002")).toMatchObject({
    parent_id: "a5002",
    author: "asker",
  });
  const md = toMarkdown(doc);
  expect(md).toContain("Tags: python, sorting");
  expect(md).toContain("xs.sort()");
  expect(md).toContain("Works, thanks!");
});

test("stackexchange without a question is not this layout", async () => {
  const error = await run(
    stackExchangeAdapter,
    "https://stackoverflow.com/questions/1/x",
    "<p>Captcha</p>",
  ).catch((e: unknown) => e);
  expect(isNotThisLayout(error)).toBe(true);
});

test("an aborted signal stops capture", async () => {
  const controller = new AbortController();
  controller.abort();
  const error = await run(
    hackerNewsAdapter,
    "https://news.ycombinator.com/item?id=4001",
    await fixture("hackernews-item.html"),
    controller.signal,
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CaptureAbortedError);
});

const hnRow = (id: number, indent: number, text: string | null) =>
  `<tr class="athing comtr" id="${id}"><td><table><tr><td class="ind" indent="${indent}"></td><td class="default"><span class="comhead"><a class="hnuser">u${id}</a></span>${
    text === null ? "" : `<div class="commtext c00">${text}</div>`
  }</td></tr></table></td></tr>`;
const hnPage = (rows: string, fat = "") =>
  `<table class="fatitem"><tr class="athing" id="1"><td class="title"><span class="titleline"><a href="item?id=1">Ask HN: x</a></span></td></tr>${fat}</table><table class="comment-tree">${rows}</table>`;

test("hackernews: replies to a deleted comment keep it as parent", async () => {
  const doc = await run(
    hackerNewsAdapter,
    "https://news.ycombinator.com/item?id=1",
    hnPage(hnRow(2, 0, "a") + hnRow(3, 1, null) + hnRow(4, 2, "reply")),
  );
  expect(find(doc, "3")).toMatchObject({ parent_id: "2", depth: 1 });
  expect(find(doc, "4")).toMatchObject({ parent_id: "3", depth: 2 });
});

test("hackernews: a comment permalink fills the post from the fat item", async () => {
  const doc = await run(
    hackerNewsAdapter,
    "https://news.ycombinator.com/item?id=1",
    `<table class="fatitem"><tr class="athing" id="1"><td class="default"><span class="comhead"><a class="hnuser">zed</a> <span class="onstory"> | on: <a href="item?id=99">The Story Title</a></span></span><div class="commtext c00">Permalinked text</div></td></tr></table>` +
      `<table class="comment-tree">${hnRow(2, 0, "child")}</table>`,
  );
  expect(doc.blocks[0]).toMatchObject({
    type: "post",
    id: "1",
    title: "The Story Title",
    author: "zed",
  });
  expect(toMarkdown(doc)).toContain("Permalinked text");
  expect(find(doc, "2")).toMatchObject({ parent_id: "1" });
});

test("an oversized block is cut without ending the thread", async () => {
  const doc = await run(
    hackerNewsAdapter,
    "https://news.ycombinator.com/item?id=1",
    hnPage(hnRow(2, 0, "x".repeat(250_000)) + hnRow(3, 0, "after")),
  );
  expect(doc.blocks.map((b) => ("id" in b ? b.id : ""))).toEqual([
    "1",
    "2",
    "3",
  ]);
  expect(doc.meta.coverage).toMatchObject({ partial: true });
  const warnings = (doc.meta.warnings ?? []).join(" ");
  expect(warnings).toContain("oversized");
  expect(warnings).not.toContain("capture limit");
});

test("generic converter warnings and per-body media reach the meta", async () => {
  const doc = await run(
    hackerNewsAdapter,
    "https://news.ycombinator.com/item?id=1",
    hnPage(
      hnRow(
        2,
        0,
        '<details><summary>s</summary>hidden</details><img src="https://e.org/i.png">',
      ) + hnRow(3, 0, '<img src="https://e.org/i.png">'),
    ),
  );
  expect(doc.meta.warnings?.join(" ")).toContain("Closed disclosure");
  const images = doc.blocks.flatMap((b) =>
    "content" in b ? (b.content ?? []).filter((c) => c.type === "media") : [],
  );
  expect(images).toHaveLength(2);
});

test("github react view is captured, with unique ids and a load-more warning", async () => {
  const doc = await run(
    githubAdapter,
    "https://github.com/o/r/issues/77",
    await fixture("github-issue-react.html"),
  );
  expect(doc.meta).toMatchObject({
    title: "Dark mode flickers",
    author: "octo",
    published: "2026-10-05T08:00:00Z",
  });
  expect(doc.meta.coverage).toMatchObject({
    layout: "react",
    state: "Closed",
    comments_captured: 2,
    partial: true,
  });
  expect(doc.meta.warnings?.join(" ")).toContain("load-more");
  const ids = doc.blocks.map((b) => ("id" in b ? b.id : ""));
  expect(new Set(ids).size).toBe(ids.length);
  expect(doc.blocks[1]).toMatchObject({
    id: "issuecomment-5002",
    author: "maint",
  });
});

test("github comments sharing a wrapper id get distinct ids", async () => {
  const comment = (name: string) =>
    `<div class="timeline-comment"><div class="timeline-comment-header"><a class="author">${name}</a></div><div class="comment-body">hi ${name}</div></div>`;
  const doc = await run(
    githubAdapter,
    "https://github.com/o/r/issues/1",
    `<div id="issuecomment-1">${comment("a")}${comment("b")}${comment("c")}</div>`,
  );
  const ids = doc.blocks.map((b) => ("id" in b ? b.id : ""));
  expect(new Set(ids).size).toBe(3);
});

test("github classic pagination marks the capture partial", async () => {
  const html =
    (await fixture("github-issue.html")) +
    '<form class="ajax-pagination-form"><button>Load more…</button></form>';
  const doc = await run(
    githubAdapter,
    "https://github.com/o/r/issues/42",
    html,
  );
  expect(doc.meta.coverage).toMatchObject({ layout: "classic", partial: true });
  expect(doc.meta.warnings?.join(" ")).toContain("load-more");
});

test("stackexchange: question comments depth 0, answer comments depth 1", async () => {
  const doc = await run(
    stackExchangeAdapter,
    "https://stackoverflow.com/questions/5001/how-do-i-sort",
    await fixture("stackexchange-question.html"),
  );
  expect(find(doc, "c7001")).toMatchObject({ depth: 0 });
  expect(find(doc, "c7002")).toMatchObject({ depth: 1 });
});

test("stackexchange: missing or paginated answers are reported as partial", async () => {
  const html = (await fixture("stackexchange-question.html")).replace(
    '<div id="answers">',
    '<div id="answers" data-answercount="5"><div class="s-pagination"><a>2</a></div>',
  );
  const doc = await run(
    stackExchangeAdapter,
    "https://stackoverflow.com/questions/5001/how-do-i-sort",
    html,
  );
  expect(doc.meta.coverage).toMatchObject({
    answers_captured: 2,
    answers_reported: 5,
    partial: true,
  });
  expect(doc.meta.warnings?.join(" ")).toContain("2 of 5");
});

test("stackexchange matches meta sites", () => {
  for (const host of [
    "meta.superuser.com",
    "meta.serverfault.com",
    "meta.askubuntu.com",
    "meta.mathoverflow.net",
  ])
    expect(stackExchangeAdapter.matches(`https://${host}/questions/1/x`)).toBe(
      true,
    );
  expect(
    stackExchangeAdapter.matches("https://meta.example.com/questions/1/x"),
  ).toBe(false);
});
