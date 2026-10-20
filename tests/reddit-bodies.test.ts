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

test("normalizeBody strips trailing NBSP and zero-width chars only at line ends", () => {
  expect(normalizeBody("a\u00A0\u200B\uFEFF\nb")).toBe("a\nb");
  expect(normalizeBody("a\n\u00A0\u200B\u200C\u200D\uFEFF\n\n\nb")).toBe(
    "a\n\nb",
  );
  expect(normalizeBody("a\u200Bb\u00A0c")).toBe("a\u200Bb\u00A0c");
  expect(normalizeBody("```\na\u00A0\n```")).toBe("```\na\u00A0\n```");
});

test("normalizeBody resolves relative links when given a base URL", () => {
  const o = { baseUrl: "https://www.reddit.com" };
  expect(
    normalizeBody("[m](/message/compose/?to=x) [r](/r/foo) ![i](/u/bar)", o),
  ).toBe(
    "[m](https://www.reddit.com/message/compose/?to=x) [r](https://www.reddit.com/r/foo) ![i](https://www.reddit.com/u/bar)",
  );
  expect(normalizeBody("[a](//x.com) [b](https://y.com) [c](rel)", o)).toBe(
    "[a](//x.com) [b](https://y.com) [c](rel)",
  );
  expect(normalizeBody("`[a](/r/foo)`\n```\n[a](/r/foo)\n```", o)).toBe(
    "`[a](/r/foo)`\n```\n[a](/r/foo)\n```",
  );
  expect(normalizeBody("[a](/r/foo)")).toBe("[a](/r/foo)");
});

test("normalizeBody escapes bare < before a letter outside code", () => {
  expect(normalizeBody("use <name> in <repo>")).toBe(
    "use \\<name> in \\<repo>",
  );
  expect(normalizeBody("already \\<name> and 1 < 2")).toBe(
    "already \\<name> and 1 < 2",
  );
  expect(normalizeBody("see <https://a.com> <mailto:a@b.c> <http://x>")).toBe(
    "see <https://a.com> <mailto:a@b.c> <http://x>",
  );
  expect(normalizeBody("`<name>` <x>\n```\n<name>\n```\n    <name>")).toBe(
    "`<name>` \\<x>\n```\n<name>\n```\n    <name>",
  );
});

test("normalizeBody skips the hard break before a fence, heading or quote", () => {
  expect(normalizeBody("a  \n```\nx\n```")).toBe("a\n```\nx\n```");
  expect(normalizeBody("a  \n~~~\nx\n~~~")).toBe("a\n~~~\nx\n~~~");
  expect(normalizeBody("a  \n# h")).toBe("a\n# h");
  expect(normalizeBody("a  \n> q")).toBe("a\n> q");
  expect(normalizeBody("a  \n- item")).toBe("a\n- item");
  expect(normalizeBody("a  \n1. item")).toBe("a\n1. item");
  expect(normalizeBody("a  \n---")).toBe("a\n---");
  expect(normalizeBody("a  \n#hashtag")).toBe("a\\\n#hashtag");
  expect(normalizeBody("a  \n\u200B\nb")).toBe("a\n\nb");
  expect(normalizeBody("x \u00A0\nb")).toBe("x\\\nb");
  expect(normalizeBody("a  \nb")).toBe("a\\\nb");
});

test("normalizeBody leaves <...> link targets and escapes after even backslashes", () => {
  expect(normalizeBody("[x](<foo bar>)")).toBe("[x](<foo bar>)");
  expect(normalizeBody("\\\\<x>")).toBe("\\\\\\<x>");
  expect(normalizeBody("\\`<x>`")).toBe("\\`\\<x>`");
  expect(normalizeBody("``a` <x>")).toBe("``a` \\<x>");
});

test("normalizeBody stays linear on long backslash and space runs", () => {
  for (const text of [
    `${"\\".repeat(40000)}x`,
    `${" ".repeat(40000)}x`,
    `${"\u00A0".repeat(40000)}x `,
  ]) {
    const t = performance.now();
    normalizeBody(text);
    expect(performance.now() - t).toBeLessThan(100);
  }
});
