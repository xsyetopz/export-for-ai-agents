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

test("normalizeBody: escaped backtick runs", () => {
  expect(normalizeBody("\\``<b>` x")).toBe("\\``<b>` x");
  expect(normalizeBody("\\`<b>`")).toBe("\\`\\<b>`");
});

test("normalizeBody: escaped backtick runs still close spans", () => {
  for (const t of [
    "``<b>\\``",
    "``<b>\\`` x",
    "\\\\``<b>``",
    "\\```<b>``",
    "x \\``",
  ])
    expect(normalizeBody(t)).toBe(t);
});

test("normalizeBody: only HTML-like lines block a hard break", () => {
  expect(normalizeBody("a  \n<3 you")).toBe("a\\\n<3 you");
  expect(normalizeBody("a  \n<div>").startsWith("a\n")).toBe(true);
});

test("normalizeBody: link destinations with leading whitespace", () => {
  expect(normalizeBody("[a](  <b c>)")).toBe("[a](  <b c>)");
  expect(normalizeBody("[a](\t<b c>)")).toBe("[a](\t<b c>)");
  expect(normalizeBody("use <name> here")).toBe("use \\<name> here");
});

test("normalizeBody: code spans cross lines within a paragraph", () => {
  expect(normalizeBody("a `<b\nc>` d")).toBe("a `<b\nc>` d");
  expect(normalizeBody("a `x  \ny` z")).toBe("a `x\ny` z");
  expect(normalizeBody("a `x\n\n<b>` y")).toBe("a `x\n\n\\<b>` y");
  expect(normalizeBody("a `x\n- <b>` y")).toBe("a `x\n- \\<b>` y");
  expect(normalizeBody("a  \nb")).toBe("a\\\nb");
});

test("normalizeBody: paragraph interruption follows CommonMark", () => {
  expect(normalizeBody("`\n<a`")).toBe("`\n<a`");
  expect(normalizeBody("`x\n<b>y`")).toBe("`x\n<b>y`");
  expect(normalizeBody("a `x\n<div>` y")).toBe(
    "a `x\n<div>` y".replace("<div>", "\\<div>"),
  );
  expect(normalizeBody("`x\n2. <b>`")).toBe("`x\n2. <b>`");
  expect(normalizeBody("> a `x\n> <b>` y")).toBe("> a `x\n> <b>` y");
  expect(normalizeBody("a `x\n> <b>` y")).toBe("a `x\n> \\<b>` y");
  expect(normalizeBody("`x\n>\n<b>`")).toBe("`x\n>\n\\<b>`");
  expect(normalizeBody("# h `x\n<b>`")).toBe("# h `x\n\\<b>`");
  expect(normalizeBody("[a](  \nb)")).toBe("[a](\nb)");
  expect(normalizeBody("[x]:  \n<y>")).toBe("[x]:\n<y>");
});

test("normalizeBody: link destination across one line break", () => {
  expect(normalizeBody("[a](\n<b c>)")).toBe("[a](\n<b c>)");
  expect(normalizeBody("[a](  \n<b c>)")).toBe("[a](\n<b c>)");
  expect(normalizeBody("[a](\n\n<b c>)")).toBe("[a](\n\n\\<b c>)");
});

test("normalizeBody: reference definition destinations", () => {
  expect(normalizeBody("[x]: <y>")).toBe("[x]: <y>");
  expect(normalizeBody("[x]:\n<y>")).toBe("[x]:\n<y>");
  expect(normalizeBody("> [x]: <y>")).toBe("> [x]: <y>");
  expect(normalizeBody("[x]: <y>\n[z]: <w>")).toBe("[x]: <y>\n[z]: <w>");
  expect(normalizeBody("foo\n[x]: <y>")).toBe("foo\n[x]: \\<y>");
});

test("normalizeBody stays linear on long backslash and space runs", () => {
  for (const text of [
    `${"\\".repeat(40000)}x`,
    `${" ".repeat(40000)}x`,
    `${"\u00A0".repeat(40000)}x `,
    " <a".repeat(13000),
    "[x]:\n".repeat(13000),
    "a `b` ``c <d` e\n".repeat(2500),
  ]) {
    const t = performance.now();
    normalizeBody(text);
    expect(performance.now() - t).toBeLessThan(100);
  }
});

test("normalizeBody: block markers inside containers take no hard break", () => {
  expect(normalizeBody("> # h  \nbar")).toBe("> # h\nbar");
  expect(normalizeBody("- # h  \nbar")).toBe("- # h\nbar");
  expect(normalizeBody("> *  \nbar")).toBe("> *\nbar");
  expect(normalizeBody("> ---  \nbar")).toBe("> ---\nbar");
  expect(normalizeBody("- ===  \nbar")).toBe("- ===\\\nbar");
  expect(normalizeBody("a  \n01) b")).toBe("a\\\n01) b");
});

test("normalizeBody: bare [label]: line keeps its hard break unless it is a definition", () => {
  expect(normalizeBody("foo\n[x]:  \nbar")).toBe("foo\n[x]:\\\nbar");
  expect(normalizeBody("[x]:  \nbar")).toBe("[x]:\nbar");
  expect(normalizeBody("[x]: <y>\n[z]:  \nbar")).toBe("[x]: <y>\n[z]:\nbar");
  expect(normalizeBody("foo\n[x]:  \n<y>")).toBe("foo\n[x]:\\\n\\<y>");
  expect(normalizeBody("foo\n[a](  \nb)")).toBe("foo\n[a](\nb)");
});

test("normalizeBody: only HTML block starts (types 1-6) block a hard break", () => {
  expect(normalizeBody("a  \n<notatag and text")).toBe(
    "a\\\n\\<notatag and text",
  );
  expect(normalizeBody("a  \n<span>b</span>")).toBe("a\\\n\\<span>b\\</span>");
  expect(normalizeBody("a  \n<b>")).toBe("a\\\n\\<b>");
  expect(normalizeBody("a  \n<divx>")).toBe("a\\\n\\<divx>");
  expect(normalizeBody("a  \n<div>")).toBe("a\n\\<div>");
  expect(normalizeBody("a  \n<DIV>")).toBe("a\n\\<DIV>");
  expect(normalizeBody("a  \n</div>")).toBe("a\n\\</div>");
  expect(normalizeBody("a  \n<pre>")).toBe("a\n\\<pre>");
  expect(normalizeBody("a  \n<!-- c -->")).toBe("a\n<!-- c -->");
  expect(normalizeBody("a  \n<?php")).toBe("a\n<?php");
  expect(normalizeBody("a  \n<![CDATA[x]]>")).toBe("a\n<![CDATA[x]]>");
  expect(normalizeBody("a  \n<!DOCTYPE html>")).toBe("a\n<!DOCTYPE html>");
});

test("normalizeBody: HTML block starts and ordered items end a paragraph", () => {
  // Interrupting lines start a new group, so the span cannot cross them.
  expect(normalizeBody("`x\n<DIV>`")).toBe("`x\n\\<DIV>`");
  expect(normalizeBody("`x\n<![CDATA[`")).toBe("`x\n<![CDATA[`");
  expect(normalizeBody("`x\n<!DOCTYPE`")).toBe("`x\n<!DOCTYPE`");
  expect(normalizeBody("`x\n1. <b>`")).toBe("`x\n1. \\<b>`");
  // Not interrupting: the span crosses the line.
  expect(normalizeBody("`x\n01) <b>`")).toBe("`x\n01) <b>`");
  expect(normalizeBody("`x\n2. <b>`")).toBe("`x\n2. <b>`");
  expect(normalizeBody("`x\n<notatag`")).toBe("`x\n<notatag`");
});

test("normalizeBody: CDATA opener is case-sensitive", () => {
  expect(normalizeBody("foo  \n<![cdata[x]]>")).toBe("foo\\\n<![cdata[x]]>");
  expect(normalizeBody("foo  \n<![CDATA[x]]>")).toBe("foo\n<![CDATA[x]]>");
});

test("normalizeBody: empty list items do not interrupt a paragraph", () => {
  expect(normalizeBody("foo  \n*  ")).toBe("foo\\\n*");
  expect(normalizeBody("foo  \n+")).toBe("foo\\\n+");
  expect(normalizeBody("foo  \n1.  ")).toBe("foo\\\n1.");
  expect(normalizeBody("foo  \n1.")).toBe("foo\\\n1.");
  expect(normalizeBody("foo  \n*  \nbar")).toBe("foo\\\n*\\\nbar");
  expect(normalizeBody("foo  \n*  a")).toBe("foo\n*  a");
  expect(normalizeBody("foo  \n-")).toBe("foo\n-");
  expect(normalizeBody("foo  \n- ")).toBe("foo\n-");
  expect(normalizeBody("`x\n*\n<b>`")).toBe("`x\n*\n<b>`");
});

test("normalizeBody: empty bullet at paragraph start takes no hard break", () => {
  expect(normalizeBody("*  \nbar")).toBe("*\nbar");
});

test("normalizeBody: empty ordered item at paragraph start takes no hard break", () => {
  expect(normalizeBody("1.  \nbar")).toBe("1.\nbar");
});

test("normalizeBody: ATX heading at paragraph start takes no hard break", () => {
  expect(normalizeBody("# h  \nbar")).toBe("# h\nbar");
});

test("normalizeBody: thematic break at paragraph start takes no hard break", () => {
  expect(normalizeBody("---  \nbar")).toBe("---\nbar");
});

test("normalizeBody: setext underline at paragraph start takes no hard break", () => {
  expect(normalizeBody("a\n===  \nbar")).toBe("a\n===\nbar");
});

test("normalizeBody: quote marker at paragraph start takes no hard break", () => {
  expect(normalizeBody(">  \nbar")).toBe(">\nbar");
});

test("normalizeBody: a marker mid-paragraph keeps the hard break", () => {
  expect(normalizeBody("a\n*  \nbar")).toBe("a\n*\\\nbar");
});

test("normalizeBody: a closing tag is escaped like an opening tag", () => {
  expect(normalizeBody("</div>")).toBe("\\</div>");
});

test("normalizeBody: a closing tag in prose is escaped", () => {
  expect(normalizeBody("a </b> c")).toBe("a \\</b> c");
});

test("normalizeBody: a closing tag inside a code span is left alone", () => {
  expect(normalizeBody("use `</div>` here")).toBe("use `</div>` here");
});

test("normalizeBody: </ not followed by a letter is not a tag", () => {
  expect(normalizeBody("1 </ 2")).toBe("1 </ 2");
  expect(normalizeBody("a </3")).toBe("a </3");
});

test("normalizeBody: a comment opener stays unchanged", () => {
  expect(normalizeBody("a <!-- c -->")).toBe("a <!-- c -->");
});

test("normalizeBody: a hard break precedes an ordered item not starting at 1", () => {
  expect(normalizeBody("a  \n2. b")).toBe("a\\\n2. b");
  expect(normalizeBody("a  \n01) b")).toBe("a\\\n01) b");
});

test("normalizeBody: an ordered item starting at 1 takes no hard break", () => {
  expect(normalizeBody("a  \n1. b")).toBe("a\n1. b");
});

test("normalizeBody: no hard break before an ordered item inside a list", () => {
  expect(normalizeBody("1. a  \n2. b")).toBe("1. a\n2. b");
  expect(normalizeBody("- a\n\n  b  \n2. c")).toBe("- a\n\n  b\n2. c");
});

test("normalizeBody: a quoted ordered item keeps today's output", () => {
  expect(normalizeBody("> a  \n> 2. b")).toBe("> a\n> 2. b");
});

test("normalizeBody: indented code inside a block quote is left untouched", () => {
  const body = "> a\n>\n>     <b>  \n>\n>     c";
  expect(normalizeBody(body)).toBe(body);
});

test("normalizeBody: indented code inside a nested quote is left untouched", () => {
  const body = "> > a\n> >\n> >     <b>  \n> >\n> >     c";
  expect(normalizeBody(body)).toBe(body);
});

test("normalizeBody: indented code after a list item inside a quote is left untouched", () => {
  const body = "> - a\n>\n>       <b>  \n>\n>       c";
  expect(normalizeBody(body)).toBe(body);
});

test("normalizeBody: a quote with only three columns of indent is prose", () => {
  expect(normalizeBody(">    <b>")).toBe(">    \\<b>");
});

test("normalizeBody: indented code after a list item is left untouched", () => {
  const body = "- a\n\n      <b>  \n\n      c";
  expect(normalizeBody(body)).toBe(body);
});

test("image URL lines: a quoted URL line inside quoted indented code is kept", async () => {
  const code = `> a\n>\n>     ${IMG}`;
  expect(await postBody(code)).toContain(`>     ${IMG}`);
});

const cut40k = (unit: string): string => {
  const text = unit.repeat(Math.ceil(40_000 / unit.length));
  return text.slice(0, 40_000);
};

const timeMs = (text: string): number => {
  normalizeBody(text);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    normalizeBody(text);
    best = Math.min(best, performance.now() - t);
  }
  return best;
};

const timingCases: [string, string][] = [
  ["many closing-tag openers", cut40k("a </b c </ d </3 ")],
  ["a long run of </", cut40k("</")],
  ["a long run of </ on one line with newlines", cut40k("</</</</\n")],
  ["one deeply nested > line", cut40k("> ")],
  ["one line of > with no spaces", cut40k(">")],
  ["many quoted indented lines", cut40k(">     x  \n")],
  ["many >>>>>> lines", cut40k(">>>>>>\n")],
  ["many mixed-tab quote lines", cut40k("> \t> \n")],
  ["many empty bullets with trailing spaces", cut40k("*  \n")],
  ["many empty dash and numbered bullets", cut40k("-  \n1.  \n")],
  ["one long line of empty bullet markers", cut40k("*  ")],
];

for (const [name, text] of timingCases) {
  test(`normalizeBody under 100 ms on 40k chars: ${name}`, () => {
    expect(timeMs(text)).toBeLessThan(100);
  });
}
