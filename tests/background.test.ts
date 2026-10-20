import { expect, test } from "bun:test";
import { type ChromeLike, createGate } from "../src/gate.ts";
import type { ExportDocument } from "../src/model.ts";

const NOW = 1_800_000_000_000;
const REDDIT = "https://www.reddit.com/r/test/comments/abc123/t/";
const PAGE = "https://example.com/a";

const doc = (url: string): ExportDocument => ({
  meta: {
    url,
    title: "T",
    captured_at: "2026-10-20T12:00:00.000Z",
    adapter: "generic",
    scope: "page",
    content_trust: "untrusted",
  },
  blocks: [{ type: "paragraph", text: "hi" }],
});

type Handler = (tabId: number, message: unknown) => Promise<unknown>;

function setup(
  tabs: Record<number, string>,
  handler: Handler,
  opts: {
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    executeScript?: () => Promise<unknown>;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
  } = {},
) {
  const store: Record<string, unknown> = {};
  const sent: Array<{
    tabId: number;
    message: { type?: string; options?: unknown };
  }> = [];
  const injected: Array<{ tabId: number; files: string[] }> = [];
  let listener:
    | Parameters<ChromeLike["runtime"]["onMessage"]["addListener"]>[0]
    | undefined;
  let platformCalls = 0;
  const chromeApi: ChromeLike = {
    runtime: {
      id: "ext",
      getURL: (p) => `chrome-extension://ext/${p}`,
      getPlatformInfo: async () => {
        platformCalls++;
        return {};
      },
      onMessage: {
        addListener: (l) => {
          listener = l;
        },
      },
    },
    tabs: {
      get: async (id) => {
        if (!(id in tabs)) throw new Error("No tab");
        return { url: tabs[id] as string };
      },
      sendMessage: async (tabId, message) => {
        sent.push({
          tabId,
          message: message as { type?: string; options?: unknown },
        });
        return handler(tabId, message);
      },
    },
    scripting: {
      executeScript: async (i) => {
        if (opts.executeScript) return opts.executeScript();
        injected.push({ tabId: i.target.tabId, files: i.files });
        return [];
      },
    },
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (items) => void Object.assign(store, items),
      },
    },
  };
  const gate = createGate(chromeApi, {
    now: opts.now ?? (() => NOW),
    sleep: opts.sleep ?? (async () => {}),
    ...(opts.setInterval ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval ? { clearInterval: opts.clearInterval } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return {
    gate,
    store,
    sent,
    injected,
    tabs,
    chromeApi,
    platformCalls: () => platformCalls,
    listener: () => listener,
  };
}

const okHandler =
  (tabs: Record<number, string>): Handler =>
  async (tabId) => ({ ok: true, doc: doc(tabs[tabId] as string) });

test("captures through the tab and returns the document", async () => {
  const tabs = { 1: PAGE };
  const s = setup(tabs, okHandler(tabs));
  const result = await s.gate.capture({ tabId: 1, options: { scope: "page" } });
  expect(result).toEqual({ ok: true, doc: doc(PAGE) });
  expect(s.sent[0]?.message).toEqual({
    type: "capture",
    options: { scope: "page" },
  });
  expect(s.injected).toEqual([]);
});

test("serializes to markdown or jsonl with filename and mime when a format is given", async () => {
  const tabs = { 1: PAGE };
  const s = setup(tabs, okHandler(tabs));
  const md = await s.gate.capture({ tabId: 1, format: "md" });
  const jl = await s.gate.capture({ tabId: 1, format: "jsonl" });
  expect(md).toMatchObject({
    ok: true,
    mime: "text/markdown;charset=utf-8",
    filename: "example.com-a-20261020T120000Z.md",
  });
  expect(jl).toMatchObject({ ok: true, mime: "application/jsonl" });
  expect((jl as { text: string }).text.split("\n")[0]).toContain(
    '"type":"document"',
  );
  expect(await s.gate.capture({ tabId: 1, format: "pdf" })).toMatchObject({
    ok: false,
    code: "invalid_request",
  });
});

test("injects content.js via files once, only when the tab does not answer", async () => {
  const tabs = { 1: PAGE };
  let first = true;
  const s = setup(tabs, async (tabId) => {
    if (first) {
      first = false;
      throw new Error(
        "Could not establish connection. Receiving end does not exist.",
      );
    }
    return { ok: true, doc: doc(tabs[tabId as 1]) };
  });
  const result = await s.gate.capture({ tabId: 1 });
  expect(result.ok).toBe(true);
  expect(s.injected).toEqual([{ tabId: 1, files: ["content.js"] }]);
  expect(s.sent).toHaveLength(2);
});

test("other sendMessage failures are reported without injection", async () => {
  const s = setup({ 1: PAGE }, async () => {
    throw new Error("boom");
  });
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    ok: false,
    code: "no_response",
  });
  expect(s.injected).toEqual([]);
});

test("validates tab id, tab existence and page protocol", async () => {
  const s = setup(
    { 1: "chrome://extensions", 2: PAGE },
    okHandler({ 2: PAGE }),
  );
  expect(await s.gate.capture({ tabId: "1" })).toMatchObject({
    code: "invalid_request",
  });
  expect(await s.gate.capture(null)).toMatchObject({ code: "invalid_request" });
  expect(await s.gate.capture({ tabId: 1.5 })).toMatchObject({
    code: "invalid_request",
  });
  expect(await s.gate.capture({ tabId: 99 })).toMatchObject({ code: "no_tab" });
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    code: "unsupported_page",
  });
  expect(s.sent).toEqual([]);
});

test("a newer request for the same tab aborts the older and discards its result", async () => {
  const tabs = { 1: PAGE };
  const releases: Array<() => void> = [];
  const s = setup(tabs, (tabId, message) => {
    if ((message as { type: string }).type === "abort")
      return Promise.resolve();
    return new Promise((resolve) =>
      releases.push(() => resolve({ ok: true, doc: doc(tabs[tabId as 1]) })),
    );
  });
  const first = s.gate.capture({ tabId: 1, options: { scope: "auto" } });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  const second = s.gate.capture({ tabId: 1, options: { scope: "page" } });
  await new Promise((r) => setTimeout(r, 0));
  expect(s.sent.map((m) => m.message.type)).toEqual([
    "capture",
    "abort",
    "capture",
  ]);
  for (const release of releases) release();
  expect(await first).toMatchObject({
    ok: false,
    code: "superseded",
    aborted: true,
  });
  expect(await second).toMatchObject({ ok: true });
});

test("different tabs do not interfere", async () => {
  const tabs = { 1: PAGE, 2: "https://example.org/b" };
  const s = setup(tabs, okHandler(tabs));
  const [a, b] = await Promise.all([
    s.gate.capture({ tabId: 1 }),
    s.gate.capture({ tabId: 2 }),
  ]);
  expect(a).toMatchObject({ ok: true });
  expect(b).toMatchObject({ ok: true });
  expect(s.sent.some((m) => m.message.type === "abort")).toBe(false);
});

test("timeout sends an abort to the tab and reports timeout", async () => {
  const s = setup(
    { 1: PAGE },
    (_t, message) =>
      (message as { type: string }).type === "abort"
        ? Promise.resolve()
        : new Promise(() => {}),
    { timeoutMs: 20 },
  );
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    ok: false,
    code: "timeout",
  });
  expect(s.sent.map((m) => m.message.type)).toEqual(["capture", "abort"]);
});

test("tab navigating during capture is rejected", async () => {
  const tabs: Record<number, string> = { 1: PAGE };
  const s = setup(tabs, async () => {
    tabs[1] = "https://example.com/other";
    return { ok: true, doc: doc(PAGE) };
  });
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    ok: false,
    code: "tab_changed",
  });
  // A hash-only change is the same document.
  const t2: Record<number, string> = { 1: PAGE };
  const s2 = setup(t2, async () => {
    t2[1] = `${PAGE}#x`;
    return { ok: true, doc: doc(PAGE) };
  });
  expect((await s2.gate.capture({ tabId: 1 })).ok).toBe(true);
});

test("adapter errors pass through code, message and aborted flag", async () => {
  const s = setup({ 1: PAGE }, async () => ({
    ok: false,
    code: "empty_selection",
    message: "Select text.",
    aborted: false,
  }));
  expect(await s.gate.capture({ tabId: 1 })).toEqual({
    ok: false,
    code: "empty_selection",
    message: "Select text.",
  });
});

test("reddit: stamps 2 s spacing before the request", async () => {
  const tabs = { 1: REDDIT };
  const s = setup(tabs, okHandler(tabs));
  expect((await s.gate.capture({ tabId: 1 })).ok).toBe(true);
  expect(s.store["redditNextRequestAt"]).toBe(NOW + 2000);
});

test("reddit: a stamp within spacing is waited out, a far one is a cooldown", async () => {
  const tabs = { 1: REDDIT };
  const sleeps: number[] = [];
  const s = setup(tabs, okHandler(tabs), {
    sleep: async (ms) => void sleeps.push(ms),
  });
  s.store["redditNextRequestAt"] = NOW + 1500;
  expect((await s.gate.capture({ tabId: 1 })).ok).toBe(true);
  expect(sleeps).toEqual([1500]);

  s.store["redditNextRequestAt"] = NOW + 90_000;
  s.sent.length = 0;
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    ok: false,
    code: "rate_limited",
    retryAt: NOW + 90_000,
  });
  expect(s.sent).toEqual([]);
});

test("reddit: a 429 from the tab stores the cooldown and returns retryAt", async () => {
  const s = setup({ 1: REDDIT }, async () => ({
    ok: false,
    code: "rate_limited",
    message: "Reddit rate limit.",
    retryAt: NOW + 120_000,
  }));
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    ok: false,
    code: "rate_limited",
    retryAt: NOW + 120_000,
  });
  expect(s.store["redditNextRequestAt"]).toBe(NOW + 120_000);
  // The cooldown now blocks the next request without touching the tab.
  s.sent.length = 0;
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    code: "rate_limited",
  });
  expect(s.sent).toEqual([]);
});

test("reddit: only one tab at a time; the slot is freed afterwards", async () => {
  const tabs = {
    1: REDDIT,
    2: "https://www.reddit.com/r/test/comments/zzz999/u/",
  };
  let release: () => void = () => {};
  const s = setup(tabs, (tabId) =>
    tabId === 1
      ? new Promise((resolve) => {
          release = () => resolve({ ok: true, doc: doc(REDDIT) });
        })
      : Promise.resolve({ ok: true, doc: doc(tabs[2]) }),
  );
  const first = s.gate.capture({ tabId: 1 });
  await new Promise((r) => setTimeout(r, 0));
  expect(await s.gate.capture({ tabId: 2 })).toMatchObject({
    ok: false,
    code: "busy",
  });
  release();
  expect((await first).ok).toBe(true);
  expect((await s.gate.capture({ tabId: 2 })).ok).toBe(true);
});

test("non-reddit pages never touch the reddit stamp", async () => {
  const tabs = { 1: PAGE };
  const s = setup(tabs, okHandler(tabs));
  s.store["redditNextRequestAt"] = NOW + 90_000;
  expect((await s.gate.capture({ tabId: 1 })).ok).toBe(true);
});

test("message listener accepts only capture messages from the popup page", async () => {
  const tabs = { 1: PAGE };
  const s = setup(tabs, okHandler(tabs));
  s.gate.install();
  const l = s.listener();
  if (!l) throw new Error("no listener");
  const call = (message: unknown, sender: { id?: string; url?: string }) =>
    new Promise<unknown>((resolve) => {
      const handled = l(message, sender, resolve);
      if (handled !== true) resolve("unhandled");
    });
  const popup = { id: "ext", url: "chrome-extension://ext/popup.html?x=1" };
  expect(await call({ type: "capture", tabId: 1 }, popup)).toMatchObject({
    ok: true,
  });
  expect(
    await call({ type: "capture", tabId: 1 }, { ...popup, id: "evil" }),
  ).toBe("unhandled");
  expect(
    await call(
      { type: "capture", tabId: 1 },
      { id: "ext", url: "https://example.com/" },
    ),
  ).toBe("unhandled");
  expect(await call({ type: "other", tabId: 1 }, popup)).toBe("unhandled");
});

const settle = () => new Promise((r) => setTimeout(r, 0));

test("reddit: a superseded request cannot free the slot of the newer one", async () => {
  const tabs = {
    1: REDDIT,
    2: "https://www.reddit.com/r/test/comments/zzz999/u/",
  };
  const releases: Array<() => void> = [];
  const s = setup(tabs, (tabId, message) => {
    if ((message as { type: string }).type === "abort")
      return Promise.resolve();
    return new Promise((resolve) =>
      releases.push(() => resolve({ ok: true, doc: doc(tabs[tabId as 1]) })),
    );
  });
  const first = s.gate.capture({ tabId: 1 });
  await settle();
  const second = s.gate.capture({ tabId: 1 });
  await settle();
  releases[0]?.();
  expect(await first).toMatchObject({ code: "superseded" });
  expect(await s.gate.capture({ tabId: 2 })).toMatchObject({
    ok: false,
    code: "busy",
  });
  releases[1]?.();
  expect((await second).ok).toBe(true);
});

test("reddit: retry_at in the coverage of a successful capture stores the cooldown", async () => {
  const s = setup({ 1: REDDIT }, async () => {
    const d = doc(REDDIT);
    d.meta.coverage = { retry_at: NOW + 300_000 };
    return { ok: true, doc: d };
  });
  expect((await s.gate.capture({ tabId: 1 })).ok).toBe(true);
  expect(s.store["redditNextRequestAt"]).toBe(NOW + 300_000);
});

test("reddit: a superseded 429 reply still stores the cooldown", async () => {
  const releases: Array<() => void> = [];
  const s = setup({ 1: REDDIT }, (_tabId, message) => {
    if ((message as { type: string }).type === "abort")
      return Promise.resolve();
    return new Promise((resolve) =>
      releases.push(() =>
        resolve({
          ok: false,
          code: "rate_limited",
          message: "x",
          retryAt: NOW + 120_000,
        }),
      ),
    );
  });
  const first = s.gate.capture({ tabId: 1 });
  await settle();
  const second = s.gate.capture({ tabId: 1 });
  await settle();
  releases[0]?.();
  expect(await first).toMatchObject({ code: "superseded" });
  expect(s.store["redditNextRequestAt"]).toBe(NOW + 120_000);
  releases[1]?.();
  await second;
});

test("reddit: spacing is re-stamped after the capture finishes", async () => {
  let clock = NOW;
  const s = setup(
    { 1: REDDIT },
    async () => {
      clock += 10_000;
      return { ok: true, doc: doc(REDDIT) };
    },
    { now: () => clock },
  );
  expect((await s.gate.capture({ tabId: 1 })).ok).toBe(true);
  expect(s.store["redditNextRequestAt"]).toBe(NOW + 10_000 + 2000);
});

test("reddit: cooldowns are clamped to one hour", async () => {
  const s = setup({ 1: REDDIT }, async () => ({
    ok: false,
    code: "rate_limited",
    message: "x",
    retryAt: NOW + 10 * 3_600_000,
  }));
  // A stored value far in the future is ignored.
  s.store["redditNextRequestAt"] = NOW + 5 * 3_600_000;
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    code: "rate_limited",
    retryAt: NOW + 3_600_000,
  });
  expect(s.store["redditNextRequestAt"]).toBe(NOW + 3_600_000);
});

test("injection failure on an unscriptable page maps to unsupported_page", async () => {
  const s = setup(
    { 1: PAGE },
    async () => {
      throw new Error(
        "Could not establish connection. Receiving end does not exist.",
      );
    },
    {
      executeScript: async () => {
        throw new Error("The extensions gallery cannot be scripted.");
      },
    },
  );
  expect(await s.gate.capture({ tabId: 1 })).toMatchObject({
    ok: false,
    code: "unsupported_page",
  });
});

test("keepalive runs only while a capture is in flight", async () => {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let release: () => void = () => {};
  const s = setup(
    { 1: PAGE },
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, doc: doc(PAGE) });
      }),
    {
      setInterval: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearInterval: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  );
  const pending = s.gate.capture({ tabId: 1 });
  await settle();
  expect(timers).toHaveLength(1);
  expect(timers[0]?.ms).toBe(20_000);
  timers[0]?.fn();
  expect(s.platformCalls()).toBe(1);
  release();
  await pending;
  expect(timers[0]?.cleared).toBe(true);
});
