import { expect, test } from "bun:test";
import { adapters, selectAdapter } from "../src/adapters/index.ts";
import {
  createRedditAdapter,
  type FetchFn,
  redditAdapter,
  redditTarget,
  retryTime,
  ThreadCache,
} from "../src/adapters/reddit.ts";
import {
  type CaptureContext,
  isNotThisLayout,
  RateLimitedError,
} from "../src/adapters/types.ts";
import { toJsonl } from "../src/serialize/jsonl.ts";
import { toMarkdown } from "../src/serialize/markdown.ts";
import { createValidator, validateJsonl } from "../tools/schema-validator.ts";

const thread: unknown = await Bun.file(
  new URL("./fixtures/reddit-thread.json", import.meta.url),
).json();
const more: unknown = await Bun.file(
  new URL("./fixtures/reddit-more.json", import.meta.url),
).json();

const URL_OK =
  "https://www.reddit.com/r/test/comments/abc123/is_this_a_thread/";
const NOW = Date.parse("2026-10-20T12:00:00Z");

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

interface Mock {
  calls: URL[];
  fetchFn: FetchFn;
}

function mockFetch(handler: (url: URL, n: number) => Response): Mock {
  const calls: URL[] = [];
  return {
    calls,
    fetchFn: async (input) => {
      calls.push(new URL(input));
      return handler(new URL(input), calls.length);
    },
  };
}

const routes = (url: URL) =>
  url.pathname.startsWith("/api/morechildren") ? ok(more) : ok(thread);

function adapterWith(m: Mock, cache = new ThreadCache()) {
  const sleeps: number[] = [];
  const adapter = createRedditAdapter({
    fetchFn: m.fetchFn,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => NOW,
    cache,
    moreSpacingMs: 0,
  });
  return { adapter, sleeps };
}

const ctx = (
  options: CaptureContext["options"] = {},
  url = URL_OK,
): CaptureContext => ({ document: {} as Document, url, options });

test("matches thread urls only; registered before generic", () => {
  expect(redditTarget(URL_OK)).toEqual({
    id: "abc123",
    origin: "https://www.reddit.com",
  });
  expect(redditTarget("https://old.reddit.com/comments/XyZ9/")?.id).toBe(
    "xyz9",
  );
  expect(redditTarget("https://www.reddit.com/r/test/")).toBeNull();
  expect(redditTarget("http://www.reddit.com/comments/abc/")).toBeNull();
  expect(redditTarget("https://evil-reddit.com/comments/abc/")).toBeNull();
  expect(redditAdapter.matches(URL_OK)).toBe(true);
  expect(adapters[0]?.id).toBe("reddit");
  expect(adapters.at(-1)?.id).toBe("generic");
  expect(selectAdapter(URL_OK).id).toBe("reddit");
  expect(selectAdapter("https://www.reddit.com/r/test/").id).toBe("generic");
});

test("normal thread maps to flat thread blocks with parent_id and depth", async () => {
  const m = mockFetch(routes);
  const { adapter } = adapterWith(m);
  const doc = await adapter.capture(ctx());
  expect(m.calls[0]?.pathname).toBe("/comments/abc123.json");
  expect(m.calls[0]?.searchParams.get("raw_json")).toBe("1");
  expect(doc.meta.adapter).toBe("reddit");
  expect(doc.meta.scope).toBe("thread");
  expect(doc.meta.content_trust).toBe("untrusted");
  expect(doc.meta.canonical).toBe(
    "https://www.reddit.com/r/test/comments/abc123/is_this_a_thread/",
  );
  const [post, ...rest] = doc.blocks;
  expect(post).toMatchObject({
    type: "post",
    id: "t3_abc123",
    parent_id: null,
    depth: 0,
    title: "Is this a thread?",
    author: "op",
    score: 42,
  });
  const body = (post as { body?: string }).body ?? "";
  expect(body).toContain("Body **text**");
  expect(body).toContain(
    "![First pic](https://preview.redd.it/m1.jpg?width=640&s=x)",
  );
  const byId = new Map(rest.map((b) => [(b as { id: string }).id, b]));
  expect(byId.get("t1_c2")).toMatchObject({ parent_id: "t1_c1", depth: 1 });
  expect(byId.get("t1_c3")).toMatchObject({ parent_id: "t1_c2", depth: 2 });
  // DFS order: replies directly follow their parent, then later siblings.
  const ids = rest.map((b) => (b as { id: string }).id);
  expect(ids.slice(0, 3)).toEqual(["t1_c1", "t1_c2", "t1_c3"]);
  expect(JSON.stringify(doc)).not.toContain("distinguished");
});

test("deleted and removed comments are kept and counted; hidden score omitted", async () => {
  const { adapter } = adapterWith(mockFetch(routes));
  const doc = await adapter.capture(ctx({ redditMore: 0 }));
  const d1 = doc.blocks.find((b) => "id" in b && b.id === "t1_d1");
  const r1 = doc.blocks.find((b) => "id" in b && b.id === "t1_r1");
  expect(d1).toMatchObject({
    author: "[deleted]",
    body: "[deleted]",
    score: -2,
  });
  expect(r1).toMatchObject({ author: "carol", body: "[removed]" });
  expect(r1).not.toHaveProperty("score");
  expect(doc.meta.coverage?.["comments_deleted_or_removed"]).toBe(2);
});

test("coverage reports partial when morechildren is disabled", async () => {
  const m = mockFetch(routes);
  const { adapter } = adapterWith(m);
  const doc = await adapter.capture(ctx({ redditMore: 0 }));
  expect(m.calls).toHaveLength(1);
  expect(doc.meta.coverage).toMatchObject({
    comments_reported: 7,
    comments_captured: 5,
    pending_comment_ids: 2,
    partial: true,
    more_requests: 0,
    sort: "confidence",
  });
  expect(doc.meta.warnings?.join("\n")).toContain("Captured 5 of 7");
});

test("morechildren expands pending ids and nests them by parent", async () => {
  const m = mockFetch(routes);
  const { adapter } = adapterWith(m);
  const doc = await adapter.capture(ctx({ redditSort: "top" }));
  expect(m.calls).toHaveLength(2);
  const req = m.calls[1];
  expect(req?.pathname).toBe("/api/morechildren.json");
  expect(req?.searchParams.get("children")).toBe("c4,c5");
  expect(req?.searchParams.get("link_id")).toBe("t3_abc123");
  expect(req?.searchParams.get("sort")).toBe("top");
  expect(doc.meta.coverage).toMatchObject({
    comments_captured: 7,
    pending_comment_ids: 0,
    partial: false,
    more_requests: 1,
  });
  expect(doc.meta.warnings).toBeUndefined();
  const c5 = doc.blocks.find((b) => "id" in b && b.id === "t1_c5");
  expect(c5).toMatchObject({ parent_id: "t1_c1", depth: 1 });
  // c5 is a late child of c1, so it is emitted inside c1's subtree.
  const ids = doc.blocks.map((b) => (b as { id: string }).id);
  expect(ids.indexOf("t1_c5")).toBeLessThan(ids.indexOf("t1_d1"));
});

test("morechildren batches stay within 100 ids and the request limit", async () => {
  const many = Array.from({ length: 250 }, (_, i) => `x${i}`);
  const big = structuredClone(thread) as Array<{
    data: { children: Array<{ kind: string; data: { children?: string[] } }> };
  }>;
  const moreNode = big[1]?.data.children.find((c) => c.kind === "more");
  if (moreNode) moreNode.data.children = many;
  const m = mockFetch((url) =>
    url.pathname.startsWith("/api/morechildren")
      ? ok({ json: { errors: [], data: { things: [] } } })
      : ok(big),
  );
  const { adapter } = adapterWith(m);
  const doc = await adapter.capture(ctx({ redditMore: 2 }));
  expect(m.calls).toHaveLength(3);
  expect(m.calls[1]?.searchParams.get("children")?.split(",")).toHaveLength(
    100,
  );
  expect(doc.meta.coverage).toMatchObject({
    more_requests: 2,
    pending_comment_ids: 50,
    requested_comments_unavailable: 200,
    partial: true,
  });
});

test("429 on the thread surfaces RateLimitedError with a bounded retryAt, no fallback", async () => {
  const m = mockFetch(
    () => new Response("", { status: 429, headers: { "Retry-After": "120" } }),
  );
  const { adapter } = adapterWith(m);
  const error = await adapter.capture(ctx()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RateLimitedError);
  expect((error as RateLimitedError).retryAt).toBe(NOW + 120_000);
  expect((error as RateLimitedError).code).toBe("rate_limited");
  expect(isNotThisLayout(error)).toBe(false);
});

test("retryTime parses seconds and dates, bounds both, falls back to 60 s", () => {
  expect(retryTime("5", NOW)).toBe(NOW + 5000);
  expect(retryTime("0", NOW)).toBe(NOW + 1000);
  expect(retryTime("999999", NOW)).toBe(NOW + 3_600_000);
  expect(retryTime(new Date(NOW + 30_000).toUTCString(), NOW)).toBe(
    NOW + 30_000,
  );
  expect(retryTime("garbage", NOW)).toBe(NOW + 60_000);
  expect(retryTime(null, NOW)).toBe(NOW + 60_000);
});

test("429 on morechildren waits a short Retry-After once, then continues", async () => {
  let moreCalls = 0;
  const m = mockFetch((url) => {
    if (!url.pathname.startsWith("/api/morechildren")) return ok(thread);
    moreCalls++;
    return moreCalls === 1
      ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
      : ok(more);
  });
  const { adapter, sleeps } = adapterWith(m);
  const doc = await adapter.capture(ctx());
  expect(moreCalls).toBe(2);
  expect(sleeps).toContain(2000);
  expect(doc.meta.coverage?.["comments_captured"]).toBe(7);
});

test("429 on morechildren with a long Retry-After keeps the partial thread with a warning", async () => {
  const m = mockFetch((url) =>
    url.pathname.startsWith("/api/morechildren")
      ? new Response("", { status: 429, headers: { "Retry-After": "300" } })
      : ok(thread),
  );
  const { adapter } = adapterWith(m);
  const doc = await adapter.capture(ctx());
  expect(m.calls).toHaveLength(2);
  expect(doc.meta.coverage).toMatchObject({
    comments_captured: 5,
    partial: true,
  });
  expect(doc.meta.warnings?.join("\n")).toContain("rate_limited");
});

test("other http errors and non-JSON bodies surface as AdapterError, not layout", async () => {
  for (const response of [
    () => new Response("", { status: 500 }),
    () => new Response("<html>", { status: 200 }),
  ]) {
    const { adapter } = adapterWith(mockFetch(response));
    const error = await adapter.capture(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isNotThisLayout(error)).toBe(false);
  }
});

test("network failure surfaces; aborted signal throws CaptureAbortedError", async () => {
  const failing = createRedditAdapter({
    fetchFn: async () => {
      throw new TypeError("offline");
    },
  });
  const net = await failing.capture(ctx()).catch((e: unknown) => e);
  expect((net as { code?: string }).code).toBe("network");

  const controller = new AbortController();
  controller.abort();
  const { adapter } = adapterWith(mockFetch(routes));
  const aborted = await adapter
    .capture({ ...ctx(), signal: controller.signal })
    .catch((e: unknown) => e);
  expect((aborted as { code?: string }).code).toBe("aborted");
});

test("non-Reddit layout throws NotThisLayoutError", async () => {
  const { adapter } = adapterWith(mockFetch(routes));
  const listing = await adapter
    .capture(ctx({}, "https://www.reddit.com/r/test/"))
    .catch((e: unknown) => e);
  expect(isNotThisLayout(listing)).toBe(true);
  const other = await adapter
    .capture(ctx({}, "https://example.com/comments/abc123/"))
    .catch((e: unknown) => e);
  expect(isNotThisLayout(other)).toBe(true);

  for (const payload of [{ not: "a thread" }, [{}, {}], []]) {
    const { adapter: a } = adapterWith(mockFetch(() => ok(payload)));
    const error = await a.capture(ctx()).catch((e: unknown) => e);
    expect(isNotThisLayout(error)).toBe(true);
  }
});

test("cache reuses the trimmed thread, honours fresh and sort", async () => {
  const m = mockFetch((url) =>
    url.pathname.startsWith("/api/morechildren") ? ok(more) : ok(thread),
  );
  const cache = new ThreadCache();
  const { adapter } = adapterWith(m, cache);
  await adapter.capture(ctx({ redditMore: 0 }));
  const hit = await adapter.capture(ctx({ redditMore: 0 }));
  expect(m.calls).toHaveLength(1);
  expect(hit.meta.coverage?.["cached"]).toBe(true);
  await adapter.capture(ctx({ redditMore: 0, fresh: true }));
  expect(m.calls).toHaveLength(2);
  await adapter.capture(ctx({ redditMore: 0, redditSort: "new" }));
  expect(m.calls).toHaveLength(3);
  expect(cache.size).toBe(2);
});

test("cache is capped by entries, chars and ttl", () => {
  const cache = new ThreadCache(2, 100, 1000);
  expect(cache.set("a", "x".repeat(40), 0)).toBe(true);
  expect(cache.set("b", "x".repeat(40), 1)).toBe(true);
  expect(cache.set("c", "x".repeat(40), 2)).toBe(true);
  expect(cache.size).toBe(2);
  expect(cache.get("a", 3)).toBeNull();
  expect(cache.chars).toBeLessThanOrEqual(100);
  expect(cache.set("huge", "x".repeat(101), 4)).toBe(false);
  expect(cache.get("huge", 5)).toBeNull();
  expect(cache.get("c", 5)).not.toBeNull();
  expect(cache.get("c", 5000)).toBeNull();
  expect(cache.size).toBe(0);
});

test("produced document validates against the schema and serializes", async () => {
  const { adapter } = adapterWith(mockFetch(routes));
  const doc = await adapter.capture(ctx());
  expect(createValidator()).toBeFunction();
  expect(validateJsonl(toJsonl(doc))).toEqual([]);
  const md = toMarkdown(doc);
  expect(md).toContain('adapter: "reddit"');
  expect(md).toContain("Late reply to c1");
});

test("hostile deep reply chains do not overflow the stack", async () => {
  type Node = { kind: "t1"; data: Record<string, unknown> };
  let node: Node | undefined;
  for (let i = 3000; i >= 1; i--) {
    node = {
      kind: "t1",
      data: {
        id: `n${i}`,
        parent_id: i === 1 ? "t3_abc123" : `t1_n${i - 1}`,
        body: "x",
        replies: node ? { kind: "Listing", data: { children: [node] } } : "",
      },
    };
  }
  const payload = structuredClone(thread) as Array<{
    data: { children: unknown[] };
  }>;
  if (payload[1] && node) payload[1].data.children = [node];
  const { adapter } = adapterWith(mockFetch(() => ok(payload)));
  const doc = await adapter.capture(ctx({ redditMore: 0 }));
  expect(doc.blocks).toHaveLength(3001);
  expect(doc.blocks.at(-1)).toMatchObject({ depth: 2999 });
});

test("content script falls back to generic only on NotThisLayoutError", async () => {
  const { Window } = await import("happy-dom");
  const { captureWithFallback } = await import("../src/content-script.ts");
  const win = new Window({ url: URL_OK });
  win.document.body.innerHTML = "<main><p>plain page</p></main>";
  const base = {
    document: win.document as unknown as Document,
    url: URL_OK,
    options: {},
  };
  const layout = adapterWith(mockFetch(() => ok({ not: "a thread" }))).adapter;
  const doc = await captureWithFallback(layout, base);
  expect(doc.meta.adapter).toBe("generic");

  const limited = adapterWith(
    mockFetch(() => new Response("", { status: 429 })),
  ).adapter;
  const error = await captureWithFallback(limited, base).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RateLimitedError);
});

test("a cached re-export makes no network calls, morechildren included", async () => {
  const m = mockFetch(routes);
  const cache = new ThreadCache();
  const { adapter } = adapterWith(m, cache);
  const first = await adapter.capture(ctx());
  const calls = m.calls.length;
  expect(calls).toBeGreaterThan(1);
  const second = await adapter.capture(ctx());
  expect(m.calls).toHaveLength(calls);
  expect(second.meta.coverage?.["cached"]).toBe(true);
  expect(second.blocks).toEqual(first.blocks);
});

test("a long 429 on morechildren puts retry_at in coverage", async () => {
  const m = mockFetch((url) =>
    url.pathname.startsWith("/api/morechildren")
      ? new Response("", { status: 429, headers: { "Retry-After": "300" } })
      : ok(thread),
  );
  const { adapter } = adapterWith(m);
  const doc = await adapter.capture(ctx());
  expect(doc.meta.coverage?.["retry_at"]).toBe(NOW + 300_000);
});

test("expansion stops at the deadline with a partial document", async () => {
  let clock = NOW;
  const m = mockFetch(routes);
  const slow: FetchFn = async (input, init) => {
    clock += 2000;
    return m.fetchFn(input, init);
  };
  const adapter = createRedditAdapter({
    fetchFn: slow,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    cache: new ThreadCache(),
    moreSpacingMs: 0,
    deadlineMs: 1000,
  });
  const doc = await adapter.capture(ctx());
  expect(doc.meta.coverage).toMatchObject({ partial: true, more_requests: 0 });
  expect(doc.meta.warnings?.join("\n")).toContain("time limit");
});

test("labels drop backslashes; comments with odd ids are skipped; huge bodies are refused", async () => {
  const odd = JSON.parse(JSON.stringify(thread)) as Array<{
    data: { children: Array<{ data: Record<string, unknown> }> };
  }>;
  const kids = odd[1]?.data.children ?? [];
  const bad = kids.find((k) => typeof k.data["id"] === "string");
  if (bad) bad.data["id"] = "a/../b";
  const m = mockFetch(() => ok(odd));
  const { adapter } = adapterWith(m);
  const doc = await adapter.capture(ctx({ redditMore: 0 }));
  expect(JSON.stringify(doc.blocks)).not.toContain("a/../b");

  const big = mockFetch(
    () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": "99999999" },
      }),
  );
  const error = await adapterWith(big)
    .adapter.capture(ctx())
    .catch((e: unknown) => e);
  expect((error as { code?: string }).code).toBe("too_large");
});
