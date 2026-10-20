import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { captureGeneric } from "../src/adapters/generic.ts";
import { parseJsonLd } from "../src/adapters/jsonld.ts";
import {
  CaptureAbortedError,
  type CaptureOptions,
  EmptySelectionError,
} from "../src/adapters/types.ts";
import type { ContentBlock, ExportDocument } from "../src/model.ts";
import { toJsonl } from "../src/serialize/jsonl.ts";
import { toMarkdown } from "../src/serialize/markdown.ts";
import { validateJsonl } from "../tools/schema-validator.ts";

const URL_ = "https://example.com/a/b?x=1";
const windows: Window[] = [];
afterEach(() => {
  for (const w of windows.splice(0)) w.happyDOM.close();
});

function page(html: string, head = "") {
  const win = new Window({ url: URL_ });
  windows.push(win);
  win.document.documentElement.setAttribute("lang", "en");
  win.document.head.innerHTML = `<title>Test page</title>${head}`;
  win.document.body.innerHTML = html;
  return win;
}

async function run(
  html: string,
  options: CaptureOptions = {},
  head = "",
  extra: Partial<Parameters<typeof captureGeneric>[0]> = {},
): Promise<ExportDocument> {
  const win = page(html, head);
  const doc = await captureGeneric({
    document: win.document as unknown as Document,
    url: URL_,
    options,
    ...extra,
  });
  expectValid(doc);
  return doc;
}

function expectValid(doc: ExportDocument) {
  expect(validateJsonl(toJsonl(doc))).toEqual([]);
  expect(toMarkdown(doc)).toContain("content_trust");
}

const types = (doc: ExportDocument) => doc.blocks.map((b) => b.type);
const blockOf = <T extends ContentBlock["type"]>(doc: ExportDocument, t: T) =>
  doc.blocks.find((b) => b.type === t) as Extract<ContentBlock, { type: T }>;

test("headings and paragraphs", async () => {
  const doc = await run(
    "<main><h1>Title</h1><p>Hello   <b>bold</b>\n world</p><h3>Sub</h3><p>x</p></main>",
  );
  expect(doc.blocks.slice(0, 4)).toEqual([
    { type: "heading", level: 1, text: "Title" },
    { type: "paragraph", text: "Hello bold world" },
    { type: "heading", level: 3, text: "Sub" },
    { type: "paragraph", text: "x" },
  ]);
  expect(doc.meta.adapter).toBe("generic");
  expect(doc.meta.scope).toBe("main");
  expect(doc.meta.language).toBe("en");
  expect(doc.meta.title).toBe("Test page");
});

test("lists with nesting and ordered flag", async () => {
  const doc = await run(
    "<main><ul><li>one</li><li>two<ol><li>a</li><li>b</li></ol></li></ul></main>",
  );
  const list = blockOf(doc, "list");
  expect(list.ordered).toBe(false);
  expect(list.items[0]).toEqual({ type: "item", text: "one" });
  expect(list.items[1]?.text).toBe("two");
  const nested = list.items[1]?.blocks?.[0];
  expect(nested?.type).toBe("list");
  expect(nested?.type === "list" && nested.ordered).toBe(true);
});

test("data table with header; layout table becomes flow", async () => {
  const doc = await run(`<main>
    <table><caption>Cap</caption><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2 <a href="/x">l</a></td></tr></table>
    <table><tr><td>layout para<table><tr><td>inner</td></tr></table></td></tr></table></main>`);
  const table = blockOf(doc, "table");
  expect(table.header).toEqual(["A", "B"]);
  expect(table.rows).toEqual([["1", "2 l"]]);
  expect(doc.blocks).toContainEqual({
    type: "paragraph",
    text: "layout para",
  });
  expect(doc.blocks).toContainEqual({
    type: "link",
    url: "https://example.com/x",
    text: "l",
  });
  expect(types(doc)).toContain("table");
});

test("code blocks keep whitespace and language", async () => {
  const doc = await run(
    '<main><pre><code class="language-ts">const a = 1;\n  if (a) {\r\n  }\n</code></pre></main>',
  );
  expect(blockOf(doc, "code")).toEqual({
    type: "code",
    language: "ts",
    text: "const a = 1;\n  if (a) {\n  }",
  });
});

test("blockquote nests blocks", async () => {
  const doc = await run(
    "<main><blockquote><p>q1</p><p>q2</p></blockquote></main>",
  );
  expect(blockOf(doc, "quote").blocks.map((b) => b.type)).toEqual([
    "paragraph",
    "paragraph",
  ]);
});

test("links are resolved, deduped and filtered; media collected once", async () => {
  const doc =
    await run(`<main><p>See <a href="/rel">rel</a> <a href="/rel">rel</a>
    <a href="javascript:alert(1)">bad</a> <a href="#top">top</a> <a href="mailto:a@b.c">mail</a>
    <img src="/i.png" alt="pic"><img src="/i.png" alt="dup"><img src="data:image/png;base64,AA">
    </p><video src="https://cdn.example.com/v.mp4"></video><audio controls style="display:block"><source src="/a.mp3"></audio>
    <iframe src="https://embed.example.com/x" title="Emb"></iframe></main>`);
  const links = doc.blocks.filter((b) => b.type === "link");
  expect(links.map((l) => l.type === "link" && l.url)).toEqual([
    "https://example.com/rel",
    "mailto:a@b.c",
  ]);
  const media = doc.blocks.filter((b) => b.type === "media");
  expect(media).toEqual([
    {
      type: "media",
      kind: "image",
      url: "https://example.com/i.png",
      alt: "pic",
    },
    { type: "media", kind: "video", url: "https://cdn.example.com/v.mp4" },
    { type: "media", kind: "audio", url: "https://example.com/a.mp3" },
    {
      type: "media",
      kind: "embed",
      url: "https://embed.example.com/x",
      title: "Emb",
    },
  ]);
  expect(doc.meta.warnings?.join(" ")).toContain("Embedded frames");
});

test("hidden content is skipped, nav/aside dropped unless scope page", async () => {
  const html = `<main><p>shown</p><p hidden>hid1</p><div style="display:none"><p>hid2</p></div>
    <div aria-hidden="true">hid3</div><script>evil()</script><style>.a{}</style>
    <nav>menu</nav><aside>side</aside></main>`;
  const text = (d: ExportDocument) => JSON.stringify(d.blocks);
  const auto = text(await run(html));
  expect(auto).toContain("shown");
  for (const gone of ["hid1", "hid2", "hid3", "evil", "menu", "side"])
    expect(auto).not.toContain(gone);
  const full = text(await run(html, { scope: "page" }));
  expect(full).toContain("menu");
  expect(full).not.toContain("hid1");
});

test("SVG tag case: labelled svg is a label, children are not leaked", async () => {
  const doc = await run(
    '<main><p>a</p><svg aria-label="Chart of sales"><text>LEAK</text></svg><svg><title>Logo</title><text>LEAK2</text></svg></main>',
  );
  const all = JSON.stringify(doc.blocks);
  expect(all).toContain("Chart of sales");
  expect(all).toContain("Logo");
  expect(all).not.toContain("LEAK");
});

test("inline wrapper containing blocks is not flattened", async () => {
  const doc = await run(
    '<main><span><h2>Head</h2><p>para one</p><p>para two</p></span><a href="/card"><div>Card title</div><div>Card text</div></a></main>',
  );
  expect(doc.blocks.slice(0, 3)).toEqual([
    { type: "heading", level: 2, text: "Head" },
    { type: "paragraph", text: "para one" },
    { type: "paragraph", text: "para two" },
  ]);
  expect(doc.blocks).toContainEqual({
    type: "link",
    url: "https://example.com/card",
    text: "Card title Card text",
  });
});

test("shadow DOM content and slots are walked", async () => {
  const win = page(
    "<main><x-card><span slot='s'>slotted</span> light</x-card></main>",
  );
  const host = win.document.querySelector("x-card");
  const root = host?.attachShadow({ mode: "open" });
  if (root)
    root.innerHTML = "<h2>In shadow</h2><div><slot name='s'></slot></div>";
  const doc = await captureGeneric({
    document: win.document as unknown as Document,
    url: URL_,
    options: {},
  });
  expectValid(doc);
  expect(doc.blocks[0]).toEqual({
    type: "heading",
    level: 2,
    text: "In shadow",
  });
  expect(JSON.stringify(doc.blocks)).toContain("slotted");
});

test("selection scope includes shadow DOM and dedupes links", async () => {
  const win = page(
    '<main><p id="p">Before <a href="/one">one</a> <a href="/one">one</a></p><x-s></x-s><p>outside <a href="/out">out</a></p></main>',
  );
  const host = win.document.querySelector("x-s");
  const root = host?.attachShadow({ mode: "open" });
  if (!root) throw new Error("no shadow");
  root.innerHTML = '<p id="sp">inside <a href="/shadow">sh</a> text</p>';
  const document = win.document as unknown as Document;
  const ctx = { document, url: URL_ };

  const light = win.document.createRange();
  light.selectNodeContents(
    win.document.getElementById("p") as NonNullable<
      ReturnType<typeof win.document.getElementById>
    >,
  );
  win.getSelection().removeAllRanges();
  win.getSelection().addRange(light);
  const a = await captureGeneric({ ...ctx, options: { scope: "selection" } });
  expectValid(a);
  expect(a.meta.scope).toBe("selection");
  expect(a.blocks.filter((b) => b.type === "link")).toEqual([
    { type: "link", url: "https://example.com/one", text: "one" },
  ]);

  const inner = win.document.createRange();
  inner.selectNodeContents(
    root.getElementById("sp") as NonNullable<
      ReturnType<typeof win.document.getElementById>
    >,
  );
  win.getSelection().removeAllRanges();
  win.getSelection().addRange(inner);
  const b = await captureGeneric({ ...ctx, options: { scope: "selection" } });
  expectValid(b);
  expect(JSON.stringify(b.blocks)).toContain("inside sh text");
  expect(b.blocks).toContainEqual({
    type: "link",
    url: "https://example.com/shadow",
    text: "sh",
  });
  expect(JSON.stringify(b.blocks)).not.toContain("/out");
});

test("empty selection is a typed error", async () => {
  const win = page("<main><p>x</p></main>");
  await expect(
    captureGeneric({
      document: win.document as unknown as Document,
      url: URL_,
      options: { scope: "selection" },
    }),
  ).rejects.toBeInstanceOf(EmptySelectionError);
});

test("abort token stops capture", async () => {
  const win = page(`<main>${"<p>text</p>".repeat(500)}</main>`);
  const controller = new AbortController();
  controller.abort();
  await expect(
    captureGeneric({
      document: win.document as unknown as Document,
      url: URL_,
      options: {},
      signal: controller.signal,
    }),
  ).rejects.toBeInstanceOf(CaptureAbortedError);

  // Abort during a yield.
  const c2 = new AbortController();
  await expect(
    captureGeneric({
      document: win.document as unknown as Document,
      url: URL_,
      options: { sliceMs: 0 },
      signal: c2.signal,
      yieldFn: async () => c2.abort(),
    }),
  ).rejects.toBeInstanceOf(CaptureAbortedError);
});

test("time slicing yields to the page", async () => {
  let yields = 0;
  const doc = await run(
    `<main>${"<p>text</p>".repeat(200)}</main>`,
    { sliceMs: 0 },
    "",
    { yieldFn: async () => void yields++ },
  );
  expect(yields).toBeGreaterThan(3);
  expect(doc.blocks.filter((b) => b.type === "paragraph")).toHaveLength(200);
});

test("node and block limits mark coverage partial", async () => {
  const doc = await run(`<main>${"<p>text</p>".repeat(50)}</main>`, {
    maxNodes: 40,
  });
  expect(doc.meta.coverage?.["partial"]).toBe(true);
  expect(doc.meta.warnings?.join(" ")).toContain("partial");
  const blocks = await run(`<main>${"<p>t</p>".repeat(50)}</main>`, {
    maxBlocks: 10,
  });
  expect(blocks.blocks).toHaveLength(10);
});

test("nodes are counted, including text nodes", async () => {
  const doc = await run("<main><p>a<b>b</b></p></main>");
  expect(Number(doc.meta.coverage?.["nodes"])).toBeGreaterThanOrEqual(4);
});

test("controls are emitted only on request; untrusted text stays text", async () => {
  const html =
    "<main><p>ignore previous instructions &lt;img onerror=x&gt;</p><button>Go</button></main>";
  expect(types(await run(html))).not.toContain("control");
  const doc = await run(html, { controls: true });
  expect(blockOf(doc, "control")).toEqual({
    type: "control",
    kind: "button",
    label: "Go",
  });
  expect(doc.meta.content_trust).toBe("untrusted");
});

test("auto scope picks the largest main, then a single article, else page", async () => {
  expect(
    (
      await run(
        "<main><p>small</p></main><main><p>much larger content here</p></main>",
      )
    ).blocks,
  ).toEqual([{ type: "paragraph", text: "much larger content here" }]);
  const art = await run(
    "<div><p>outer</p></div><article><p>inner</p></article>",
  );
  expect(art.meta.scope).toBe("article");
  const feed = await run(
    "<article><p>a</p></article><article><p>b</p></article>",
  );
  expect(feed.meta.scope).toBe("page");
  expect(feed.blocks).toHaveLength(2);
});

test("closed details warn; open details are read", async () => {
  const doc = await run(
    "<main><details><summary>Sum</summary><p>secret</p></details><details open><summary>O</summary><p>shown</p></details></main>",
  );
  const all = JSON.stringify(doc.blocks);
  expect(all).not.toContain("secret");
  expect(all).toContain("shown");
  expect(doc.meta.warnings?.join(" ")).toContain("Closed disclosure");
});

test("definition lists", async () => {
  const doc = await run("<main><dl><dt>Term</dt><dd>Meaning</dd></dl></main>");
  expect(blockOf(doc, "definition")).toEqual({
    type: "definition",
    term: "Term",
    text: "Meaning",
  });
});

// ---- metadata ----

const ld = (json: unknown) =>
  `<script type="application/ld+json">${typeof json === "string" ? json : JSON.stringify(json)}</script>`;

test("JSON-LD Article feeds meta", async () => {
  const doc = await run(
    "<main><p>x</p></main>",
    {},
    `${ld({
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: "H",
      description: "D",
      author: [{ "@type": "Person", name: "Ann" }, "Bob"],
      datePublished: "2026-01-02T03:04:05Z",
      publisher: { name: "Pub" },
    })}`,
  );
  expect(doc.meta.author).toBe("Ann, Bob");
  expect(doc.meta.published).toBe("2026-01-02T03:04:05Z");
  expect(doc.meta.description).toBe("D");
  expect(doc.meta.site).toBe("Pub");
});

test("JSON-LD @graph, @id references, QAPage, arrays, malformed", () => {
  expect(
    parseJsonLd([
      "{not json",
      ld("x"),
      JSON.stringify({
        "@graph": [
          { "@type": "WebSite", name: "ignored" },
          { "@id": "#p", "@type": "Person", name: "Cy" },
          {
            "@type": ["Thing", "DiscussionForumPosting"],
            headline: "Thread",
            author: { "@id": "#p" },
            datePublished: "2026-02-01",
          },
        ],
      }),
    ]),
  ).toEqual({ title: "Thread", author: "Cy", published: "2026-02-01" });

  expect(
    parseJsonLd([
      JSON.stringify([
        {
          "@type": "QAPage",
          mainEntity: {
            "@type": "Question",
            name: "How?",
            author: { name: "Dee" },
            dateCreated: "2026-03-03",
          },
        },
      ]),
    ]),
  ).toEqual({ title: "How?", author: "Dee", published: "2026-03-03" });

  expect(parseJsonLd(["null", "42", '"s"', "[]", "{}"])).toEqual({});
  expect(parseJsonLd(["x".repeat(1_000_001)])).toEqual({});
  // Total budget: valid scripts beyond ~2 MB are ignored.
  const filler = JSON.stringify({
    "@type": "Thing",
    note: "y".repeat(900_000),
  });
  const article = JSON.stringify({ "@type": "Article", headline: "Late" });
  expect(parseJsonLd([filler, filler, filler, article])).toEqual({});
  expect(parseJsonLd([filler, article])).toEqual({ title: "Late" });
  expect(
    parseJsonLd([
      JSON.stringify({
        "@type": "Article",
        author: { name: 5 },
        datePublished: 7,
      }),
    ]),
  ).toEqual({});
});

test("meta fallbacks, canonical, bad language, no title", async () => {
  const win = page(
    "<main><p>x</p></main>",
    '<link rel="canonical" href="/canon"><meta name="description" content=" desc  here "><meta property="og:site_name" content="Site">',
  );
  win.document.title = "";
  win.document.documentElement.setAttribute("lang", "not a tag!");
  const doc = await captureGeneric({
    document: win.document as unknown as Document,
    url: URL_,
    options: {},
  });
  expectValid(doc);
  expect(doc.meta.canonical).toBe("https://example.com/canon");
  expect(doc.meta.description).toBe("desc here");
  expect(doc.meta.site).toBe("Site");
  expect(doc.meta.language).toBeUndefined();
  expect(doc.meta.title).toBe(URL_);
});

test("output renders through both serializers", async () => {
  const doc = await run(
    '<main><h1>T</h1><p>p <a href="/l">l</a></p><ul><li>i</li></ul><pre>c</pre></main>',
  );
  const md = toMarkdown(doc);
  expect(md).toContain("# T");
  expect(md).toContain("[l](https://example.com/l)");
});

// ---- caps, spans, roles, truncation ----

test("block cap keeps the list and table already built", async () => {
  const doc = await run(`<main><ul>${"<li>i</li>".repeat(30)}</ul></main>`, {
    maxBlocks: 20,
  });
  expect(doc.blocks.map((b) => b.type)).toEqual(["list"]);
  const list = blockOf(doc, "list");
  expect(list.items.length).toBeGreaterThan(10);
  expect(list.items.length).toBeLessThan(30);
  expect(doc.meta.coverage?.["partial"]).toBe(true);

  const rows = "<tr><td>c</td></tr>".repeat(30);
  const t = await run(`<main><table>${rows}</table></main>`, { maxBlocks: 20 });
  expect(blockOf(t, "table").rows.length).toBeGreaterThan(10);
});

test("inline custom elements stay in the paragraph", async () => {
  const doc = await run(
    "<main><p>Posted <relative-time>3 days ago</relative-time> by bob</p><div>Posted <relative-time>now</relative-time> by amy</div></main>",
  );
  expect(doc.blocks).toEqual([
    { type: "paragraph", text: "Posted 3 days ago by bob" },
    { type: "paragraph", text: "Posted now by amy" },
  ]);
});

test("huge text is capped per paragraph", async () => {
  const doc = await run(`<main><div>${"word ".repeat(600_000)}</div></main>`);
  const p = blockOf(doc, "paragraph");
  expect(p.text.length).toBeLessThanOrEqual(200_000);
  expect(doc.meta.coverage?.["partial"]).toBe(true);
});

test("an oversized block does not block later blocks", async () => {
  const big = "x".repeat(480_000);
  const pres = Array.from({ length: 20 }, () => `<pre>${big}</pre>`).join("");
  const doc = await run(`<main>${pres}<p>after</p></main>`);
  const codes = doc.blocks.filter((b) => b.type === "code").length;
  expect(codes).toBeGreaterThan(10);
  expect(codes).toBeLessThan(20);
  expect(doc.blocks.at(-1)).toEqual({ type: "paragraph", text: "after" });
  expect(doc.meta.coverage?.["partial"]).toBe(true);
});

test("colspan pads and rowspan carries down", async () => {
  const doc = await run(`<main><table>
    <tr><th>A</th><th colspan="2">BC</th></tr>
    <tr><td rowspan="2">x</td><td>y</td><td>z</td></tr>
    <tr><td>y2</td><td>z2</td></tr></table></main>`);
  const t = blockOf(doc, "table");
  expect(t.header).toEqual(["A", "BC", ""]);
  expect(t.rows).toEqual([
    ["x", "y", "z"],
    ["", "y2", "z2"],
  ]);
});

test("role=list works; ol start is kept", async () => {
  const doc = await run(
    `<main><div role="list"><div role="listitem">a</div><div role="listitem">b</div></div>
    <ol start="5"><li>five</li><li>six</li></ol></main>`,
  );
  const [first, second] = doc.blocks;
  expect(first).toEqual({
    type: "list",
    ordered: false,
    items: [
      { type: "item", text: "a" },
      { type: "item", text: "b" },
    ],
  });
  expect(second?.type === "list" && second.start).toBe(5);
  const md = toMarkdown(doc);
  expect(md).toContain("5. five");
  expect(md).toContain("6. six");
});

test("data table with paragraphs in cells stays a table", async () => {
  const doc = await run(
    "<main><table><tr><th>K</th><th>V</th></tr><tr><td><p>a</p></td><td><ul><li>b</li></ul></td></tr></table></main>",
  );
  expect(blockOf(doc, "table").rows).toEqual([["a", "b"]]);
});

test("link wrapping a long article keeps a bounded label", async () => {
  const paras = "<p>long long long long long long long long</p>".repeat(500);
  const doc = await run(`<main><a href="/x">${paras}</a></main>`);
  const link = blockOf(doc, "link");
  expect(link.text.length).toBeLessThanOrEqual(2000);
});

test("real-browser visibility path: checkVisibility stub and display: contents", async () => {
  const win = page(
    '<main><p>ok</p><div id="gone"><p>gone</p></div><div id="contents"><p>kept</p></div></main>',
  );
  let proto = Object.getPrototypeOf(win.document.createElement("div"));
  while (proto && !Object.hasOwn(proto, "checkVisibility"))
    proto = Object.getPrototypeOf(proto);
  const original = proto.checkVisibility;
  const calls: string[] = [];
  proto.checkVisibility = function (this: Element) {
    calls.push(this.localName);
    return this.id !== "gone" && this.id !== "contents";
  };
  const contents = win.document.getElementById("contents");
  contents?.setAttribute("style", "display: contents");
  try {
    const doc = await captureGeneric({
      document: win.document as unknown as Document,
      url: URL_,
      options: {},
    });
    const all = JSON.stringify(doc.blocks);
    expect(all).toContain("ok");
    expect(all).toContain("kept");
    expect(all).not.toContain("gone");
    expect(calls.length).toBeGreaterThan(3);
  } finally {
    proto.checkVisibility = original;
  }
});

test("NaN and negative limits fall back to defaults", async () => {
  const doc = await run("<main><p>a</p><p>b</p></main>", {
    maxNodes: Number.NaN,
    maxBlocks: -5,
  });
  expect(doc.blocks).toHaveLength(2);
});

test("selection across a shadow boundary keeps links on both sides", async () => {
  const win = page(
    '<main><p id="l">light <a href="/l">ll</a></p><x-s></x-s></main>',
  );
  const root = win.document
    .querySelector("x-s")
    ?.attachShadow({ mode: "open" });
  if (!root) throw new Error("no shadow");
  root.innerHTML = '<p>in <a href="/s">ss</a></p>';
  const sel = win.getSelection();
  sel.removeAllRanges();
  const range = win.document.createRange();
  range.selectNodeContents(
    win.document.getElementById("l") as NonNullable<
      ReturnType<typeof win.document.getElementById>
    >,
  );
  sel.addRange(range);
  // Emulate Chrome's composed range from the light paragraph into the shadow paragraph.
  const lightText = win.document.getElementById("l")?.firstChild;
  const shadowP = root.firstChild;
  Object.defineProperty(sel, "getComposedRanges", {
    value: () => [
      {
        startContainer: lightText,
        startOffset: 0,
        endContainer: shadowP,
        endOffset: 1,
      },
    ],
  });
  Object.defineProperty(sel, "anchorNode", { value: lightText });
  Object.defineProperty(sel, "focusNode", { value: shadowP });
  const doc = await captureGeneric({
    document: win.document as unknown as Document,
    url: URL_,
    options: { scope: "selection" },
  });
  expectValid(doc);
  const urls = doc.blocks.flatMap((b) => (b.type === "link" ? [b.url] : []));
  expect(urls).toContain("https://example.com/l");
  expect(urls).toContain("https://example.com/s");
});
