import type { ExportDocument } from "../../src/model.ts";

export const articleDoc: ExportDocument = {
  meta: {
    url: "https://example.com/post?a=1",
    canonical: "https://example.com/post",
    title: "Hello: a #title",
    description: "Short description",
    language: "en",
    captured_at: "2026-09-23T00:00:00Z",
    adapter: "generic",
    scope: "page",
    site: "Example",
    coverage: { blocks: 9, partial: false },
    warnings: ["something was skipped"],
    content_trust: "untrusted",
  },
  blocks: [
    { type: "heading", level: 2, text: "Intro" },
    { type: "paragraph", text: "Some *text* with [brackets]" },
    {
      type: "list",
      ordered: true,
      items: [
        { type: "item", text: "one" },
        {
          type: "item",
          text: "two",
          blocks: [
            {
              type: "list",
              ordered: false,
              items: [{ type: "item", text: "nested" }],
            },
          ],
        },
      ],
    },
    { type: "quote", blocks: [{ type: "paragraph", text: "quoted" }] },
    { type: "code", language: "ts", text: "const a = ```;\n" },
    { type: "table", header: ["a", "b"], rows: [["1|2", "x\ny"]] },
    {
      type: "media",
      kind: "image",
      url: "https://example.com/i.png",
      alt: "pic",
    },
    { type: "media", kind: "embed", url: "https://example.com/e" },
    { type: "definition", term: "term", text: "meaning" },
    { type: "control", kind: "button", label: "Go" },
    { type: "link", url: "https://example.com/(x)", text: "example page" },
  ],
};

export const threadDoc: ExportDocument = {
  meta: {
    url: "https://www.reddit.com/r/x/comments/abc/t/",
    title: "Thread",
    captured_at: "2026-09-23T12:34:56Z",
    adapter: "reddit",
    scope: "thread",
    content_trust: "untrusted",
  },
  blocks: [
    {
      type: "post",
      id: "t3_abc",
      parent_id: null,
      title: "Q?",
      author: "op",
      score: 10,
      depth: 0,
      body: "Body",
    },
    {
      type: "comment",
      id: "t1_a",
      parent_id: "t3_abc",
      author: "u1",
      score: 3,
      date: "2026-09-22",
      depth: 0,
      body: "top",
    },
    {
      type: "comment",
      id: "t1_b",
      parent_id: "t1_a",
      author: "u2",
      depth: 1,
      content: [{ type: "paragraph", text: "reply" }],
    },
    {
      type: "answer",
      id: "a1",
      parent_id: "t3_abc",
      accepted: true,
      depth: 0,
      body: "ans",
    },
  ],
};

export const fixtures: Record<string, ExportDocument> = {
  articleDoc,
  threadDoc,
};
