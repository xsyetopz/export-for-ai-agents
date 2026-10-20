import { expect, test } from "bun:test";
import { createRedditAdapter } from "../src/adapters/reddit.ts";
import type { ExportDocument } from "../src/model.ts";
import { normalizeBody, unclosedFence } from "../src/normalize.ts";
import { toJsonl } from "../src/serialize/jsonl.ts";
import { toMarkdown } from "../src/serialize/markdown.ts";

const IMG =
  "https://preview.redd.it/4twwk0ph3jwh1.png?width=1600&format=png&auto=webp&s=14c8e0fe";
const URL_REAL =
  "https://www.reddit.com/r/ClaudeAI/comments/1xafaai/why_is_claude_taking_up_so_much_space/";
const TITLE = "Why is Claude taking up SO MUCH space?";

const thread = [
  {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            id: "1xafaai",
            title: TITLE,
            author: "LorestForest",
            subreddit: "ClaudeAI",
            permalink: "/r/ClaudeAI/comments/1xafaai/x/",
            selftext: "And what can I do about it?",
            score: 5,
            created_utc: 1789997832,
            is_self: true,
          },
        },
      ],
    },
  },
  {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t1",
          data: {
            id: "phtczrt",
            parent_id: "t3_1xafaai",
            author: "DocumentFun9077",
            score: 23,
            created_utc: 1789998000,
            body: IMG,
            media_metadata: {
              a: { status: "valid", s: { u: IMG.replace(/&/g, "&amp;") } },
            },
            replies: {
              kind: "Listing",
              data: {
                children: [
                  {
                    kind: "t1",
                    data: {
                      id: "phtasgn",
                      parent_id: "t1_phtczrt",
                      author: "XeNoGeaR52",
                      score: 7,
                      created_utc: 1789998100,
                      body: "help?   \n  \nAlso...   \n\n\n\n```\ncode   \n  \n\n\nx\n```\n",
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
];

async function capture(): Promise<ExportDocument> {
  const adapter = createRedditAdapter({
    fetchFn: async () =>
      new Response(JSON.stringify(thread), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    sleep: async () => undefined,
    now: () => Date.parse("2026-10-20T12:00:00Z"),
  });
  return adapter.capture({
    document: {} as Document,
    url: URL_REAL,
    options: {},
  });
}

const bodyOf = (doc: ExportDocument, id: string): string =>
  (doc.blocks.find((b) => "id" in b && b.id === id) as { body?: string })
    .body ?? "";

test("bare URL repeating an image is dropped; image stays", async () => {
  const doc = await capture();
  const body = bodyOf(doc, "t1_phtczrt");
  expect(body).toBe(`![image](${IMG})`);
  expect(toJsonl(doc)).not.toContain(`"body":"${IMG}`);
  expect(toMarkdown(doc).split(IMG).length - 1).toBe(1);
});

test("body whitespace is normalized outside code fences", async () => {
  const body = bodyOf(await capture(), "t1_phtasgn");
  expect(body).toBe("help?\n\nAlso...\n\n```\ncode   \n  \n\n\nx\n```");
  expect(normalizeBody("a  \n \t\n\n\n\nb\n\n")).toBe("a\n\nb");
});

test("markdown: post title deduped, blank line after every meta line, score kept", async () => {
  const doc = await capture();
  const md = toMarkdown(doc);
  expect(md).toContain("`t3_1xafaai`\n\nAnd what can I do");
  expect(md).not.toContain(`**${TITLE}**`);
  expect(md).toContain("`t1_phtczrt`\n\n![image]");
  expect(md).toContain("> **XeNoGeaR52** · 7");
  expect(md).toContain("`t1_phtasgn`\n>\n> help?");
  expect(bodyOf(doc, "t3_1xafaai")).toBe("And what can I do about it?");
  expect(doc.blocks[0]).toMatchObject({ type: "post", score: 5 });
  const differing = toMarkdown({
    ...doc,
    meta: { ...doc.meta, title: "Other" },
  });
  expect(differing).toContain(`\`t3_1xafaai\`\n\n**${TITLE}**\n\nAnd what`);
});

test("front matter carries scope and site like the JSONL header", async () => {
  const doc = await capture();
  const md = toMarkdown(doc);
  expect(md).toContain(
    'adapter: "reddit"\nscope: "thread"\nsite: "Reddit r/ClaudeAI"',
  );
  const header = JSON.parse(toJsonl(doc).split("\n")[0] ?? "{}");
  expect(header.scope).toBe("thread");
  expect(header.site).toBe("Reddit r/ClaudeAI");
});

const OTHER = "https://preview.redd.it/other.png?width=1&format=png";

async function postBody(selftext: string): Promise<string> {
  const data = JSON.parse(JSON.stringify(thread));
  const post = data[0].data.children[0].data;
  post.selftext = selftext;
  post.media_metadata = { a: { status: "valid", s: { u: IMG } } };
  const adapter = createRedditAdapter({
    fetchFn: async () =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    sleep: async () => undefined,
    now: () => Date.parse("2026-10-20T12:00:00Z"),
  });
  const doc = await adapter.capture({
    document: {} as Document,
    url: URL_REAL,
    options: {},
  });
  return bodyOf(doc, "t3_1xafaai");
}

test("image URL lines: same dropped, different and captioned kept", async () => {
  const img = `![image](${IMG})`;
  expect(await postBody(`intro\n\n${IMG}\n\n[${IMG}](${IMG})`)).toBe(
    `intro\n\n${img}`,
  );
  const kept = await postBody(`${OTHER}\n\n[see this](${IMG})`);
  expect(kept).toContain(OTHER);
  expect(kept).toContain(`[see this](${IMG})`);
});

test("URL lines inside fences are kept, ~~~ included", async () => {
  expect(await postBody(`~~~\n${IMG}\n~~~`)).toBe(
    `~~~\n${IMG}\n~~~\n\n![image](${IMG})`,
  );
  expect(await postBody(`\`\`\`\n${IMG}\n\`\`\``)).toContain(`\n${IMG}\n`);
  expect(await postBody(`text\n\n    ${IMG}`)).toContain(`    ${IMG}`);
});

test("image is appended after closing an unclosed fence", async () => {
  expect(await postBody("```js\ncode")).toBe(
    `\`\`\`js\ncode\n\`\`\`\n\n![image](${IMG})`,
  );
});

test("normalizeBody turns a trailing double space into a backslash hard break", () => {
  expect(normalizeBody("a  \nb")).toBe("a\\\nb");
  expect(normalizeBody("a  \n\nb")).toBe("a\n\nb");
  expect(normalizeBody("a  ")).toBe("a");
});

test("normalizeBody keeps leading indented code", () => {
  expect(normalizeBody("\n    code\n\n\n    more\n\ntext")).toBe(
    "    code\n\n\n    more\n\ntext",
  );
});

test("normalizeBody protects fences with prefixes, tildes and bad info strings", () => {
  expect(normalizeBody("~~~\na  \n\n\n\nb\n~~~")).toBe(
    "~~~\na  \n\n\n\nb\n~~~",
  );
  expect(normalizeBody("> ```\n> a  \n\n\n> ```")).toBe(
    "> ```\n> a  \n\n\n> ```",
  );
  expect(normalizeBody("\t```\na  \n\n\n\nb\n```")).toBe(
    "\t```\na  \n\n\n\nb\n```",
  );
  expect(normalizeBody("```js```\na  \n\n\n\nb")).toBe("```js```\na\n\nb");
});

test("unclosedFence reports the open fence", () => {
  expect(unclosedFence("```js\nx")).toBe("```");
  expect(unclosedFence("~~~~\nx\n~~~~")).toBeNull();
});
