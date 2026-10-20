import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import type { ExportDocument } from "../src/model.ts";
import { exportFilename } from "../src/naming.ts";
import { initPopup, type PopupEnv } from "../src/popup.ts";
import {
  buildOptions,
  describeRetry,
  SETTINGS_KEY,
  sanitizeSettings,
  stripRetryTime,
  summarizeCoverage,
} from "../src/popup-logic.ts";
import { toJsonl } from "../src/serialize/jsonl.ts";
import { toMarkdown } from "../src/serialize/markdown.ts";

const html = readFileSync(
  new URL("../static/popup.html", import.meta.url),
  "utf8",
);
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/
  .exec(html)?.[1]
  ?.replace(/<script[\s\S]*?<\/script>/, "") as string;

const doc = (
  over: Partial<ExportDocument["meta"]> = {},
  blocks = 1,
): ExportDocument => ({
  meta: {
    url: "https://example.com/a",
    title: "T",
    captured_at: "2026-10-20T12:00:00.000Z",
    adapter: "generic",
    scope: "page",
    content_trust: "untrusted",
    ...over,
  },
  blocks: Array.from({ length: blocks }, (_, i) => ({
    type: "paragraph" as const,
    text: `hello ${i}`,
  })),
});

interface Opts {
  url?: string;
  stored?: unknown;
  replies?: unknown[];
  clipboardFails?: boolean;
  tabs?: Array<{ id?: number; url?: string }>;
  send?: (m: unknown) => Promise<unknown>;
}

async function setup(opts: Opts = {}) {
  const win = new Window({ url: "chrome-extension://x/popup.html" });
  win.document.body.innerHTML = bodyHtml;
  const sent: Array<{ tabId: number; options: Record<string, unknown> }> = [];
  const store: Record<string, unknown> = {};
  if (opts.stored !== undefined) store[SETTINGS_KEY] = opts.stored;
  const sets: Array<Record<string, unknown>> = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const replies = [...(opts.replies ?? [{ ok: true, doc: doc() }])];
  const clipboard: string[] = [];
  const clock = { now: 1_000_000 };
  const downloads: Array<[string, string, string]> = [];
  const env: PopupEnv = {
    document: win.document as unknown as Document,
    chrome: {
      tabs: {
        query: async () =>
          opts.tabs ?? [{ id: 7, url: opts.url ?? "https://example.com/a" }],
      },
      runtime: {
        sendMessage: async (m) => {
          sent.push(m as never);
          if (opts.send) return opts.send(m);
          return replies.length > 1 ? replies.shift() : replies[0];
        },
      },
      storage: {
        local: {
          get: async (k) => ({ [k]: store[k] }),
          set: async (items) => {
            sets.push(items);
            Object.assign(store, items);
          },
        },
      },
    },
    writeClipboard: async (t) => {
      if (opts.clipboardFails) throw new Error("denied");
      clipboard.push(t);
    },
    download: (f, m, t) => void downloads.push([f, m, t]),
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      if (h) (h as { live: boolean }).live = false;
    },
    now: () => clock.now,
  };
  const popup = await initPopup(env);
  if (opts.send) await new Promise((r) => setTimeout(r, 0));
  else await popup.ready;
  const d = win.document as unknown as Document;
  const q = <T extends HTMLElement>(id: string) => d.getElementById(id) as T;
  const flush = async () => {
    for (const t of timers.filter((x) => x.live)) {
      t.live = false;
      t.fn();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  const change = (el: HTMLElement) =>
    el.dispatchEvent(new win.Event("change") as never);
  return {
    clock,
    env,
    d,
    q,
    sent,
    sets,
    clipboard,
    downloads,
    flush,
    change,
    store,
    win,
  };
}

test("captures on open, renders coverage and size", async () => {
  const t = await setup();
  expect(t.sent.length).toBe(1);
  expect(t.sent[0]?.tabId).toBe(7);
  expect(t.sent[0]?.options).toEqual({ scope: "auto" });
  expect(t.d.body.dataset["state"]).toBe("ready");
  expect(t.q("n-items").textContent).toBe("1");
  expect(t.q("host").textContent).toBe("example.com");
  expect((t.q("copy") as HTMLButtonElement).disabled).toBe(false);
});

test("settings load before first capture and apply", async () => {
  const t = await setup({
    stored: { format: "jsonl", advanced: true, scope: "page", maxBlocks: 5000 },
  });
  expect(t.sent[0]?.options).toEqual({ scope: "page", maxBlocks: 5000 });
  expect(t.q<HTMLDetailsElement>("advanced").open).toBe(true);
  expect(t.q("save").textContent).toBe("Save .jsonl");
});

test("format and selects persist immediately, number input is debounced", async () => {
  const t = await setup({ url: "https://www.reddit.com/r/a/comments/1/x/" });
  const jsonl = t.d.querySelector('input[value="jsonl"]') as HTMLInputElement;
  jsonl.checked = true;
  t.change(jsonl);
  expect(t.sets.length).toBe(1);
  const more = t.q<HTMLInputElement>("reddit-more");
  more.value = "9";
  t.change(more);
  expect(t.sets.length).toBe(1);
  await t.flush();
  expect(t.sets.length).toBe(2);
  const saved = t.sets[1]?.[SETTINGS_KEY] as
    | { format: string; redditMore: number }
    | undefined;
  expect(saved?.format).toBe("jsonl");
  expect(saved?.redditMore).toBe(9);
});

test("pending debounced settings are flushed on pagehide and hidden", async () => {
  const t = await setup({ url: "https://www.reddit.com/r/a/comments/1/x/" });
  const more = t.q<HTMLInputElement>("reddit-more");
  more.value = "7";
  t.change(more);
  expect(t.sets.length).toBe(0);
  t.win.dispatchEvent(new t.win.Event("pagehide") as never);
  expect(t.sets.length).toBe(1);
  more.value = "8";
  t.change(more);
  Object.defineProperty(t.win.document, "visibilityState", {
    value: "hidden",
    configurable: true,
  });
  t.win.document.dispatchEvent(new t.win.Event("visibilitychange") as never);
  expect(t.sets.length).toBe(2);
  expect(
    (t.sets[1]?.[SETTINGS_KEY] as { redditMore: number } | undefined)
      ?.redditMore,
  ).toBe(8);
});

test("invalid reddit-more input is reverted and not saved", async () => {
  const t = await setup({ url: "https://www.reddit.com/r/a/comments/1/x/" });
  const more = t.q<HTMLInputElement>("reddit-more");
  for (const bad of ["99", "-1", "", "2.5"]) {
    more.value = bad;
    t.change(more);
    expect(more.value).toBe("5");
  }
  await t.flush();
  expect(t.sent.length).toBe(1);
  expect(t.sets.length).toBe(0);
});

test("format switch serializes locally without recapture", async () => {
  const t = await setup();
  const jsonl = t.d.querySelector('input[value="jsonl"]') as HTMLInputElement;
  jsonl.checked = true;
  t.change(jsonl);
  expect(t.sent.length).toBe(1);
  expect(t.q("save").textContent).toBe("Save .jsonl");
  (t.q("copy") as HTMLButtonElement).click();
  await t.flush();
  expect(t.clipboard).toEqual([toJsonl(doc())]);
  expect(t.q("copy").textContent).toBe("Copied");
});

test("save downloads with naming.ts filename", async () => {
  const t = await setup();
  (t.q("save") as HTMLButtonElement).click();
  const d0 = doc();
  expect(t.downloads).toEqual([
    [
      exportFilename(d0.meta.url, d0.meta.captured_at, "md"),
      "text/markdown;charset=utf-8",
      toMarkdown(d0),
    ],
  ]);
  expect(t.q("save").textContent).toBe("Saved");
});

test("preview equals export text, only when Advanced is open", async () => {
  const t = await setup();
  expect(t.q<HTMLTextAreaElement>("preview").value).toBe("");
  const details = t.q<HTMLDetailsElement>("advanced");
  details.open = true;
  details.dispatchEvent(new t.win.Event("toggle") as never);
  expect(t.q<HTMLTextAreaElement>("preview").value).toBe(toMarkdown(doc()));
  const jsonl = t.d.querySelector('input[value="jsonl"]') as HTMLInputElement;
  jsonl.checked = true;
  t.change(jsonl);
  expect(t.q<HTMLTextAreaElement>("preview").value).toBe(toJsonl(doc()));
});

test("option change recaptures after debounce", async () => {
  const t = await setup();
  const scope = t.q<HTMLSelectElement>("scope");
  scope.value = "selection";
  t.change(scope);
  expect(t.sent.length).toBe(1);
  await t.flush();
  expect(t.sent.length).toBe(2);
  expect(t.sent[1]?.options).toEqual({ scope: "selection" });
});

test("refresh bypasses caches with fresh", async () => {
  const t = await setup();
  (t.q("refresh") as HTMLButtonElement).click();
  await t.flush();
  expect(t.sent[1]?.options["fresh"]).toBe(true);
});

test("reddit options only on Reddit pages", async () => {
  const other = await setup();
  expect(other.q<HTMLFieldSetElement>("reddit").disabled).toBe(true);
  const r = await setup({ url: "https://www.reddit.com/r/a/comments/1/x/" });
  expect(r.q<HTMLFieldSetElement>("reddit").disabled).toBe(false);
  expect(r.sent[0]?.options).toEqual({
    scope: "auto",
    redditSort: "confidence",
    redditMore: 5,
  });
});

test("error state: Retry is disabled until retryAt, one retry time", async () => {
  const t = await setup({
    replies: [
      {
        ok: false,
        code: "rate_limited",
        message: "Reddit rate limit. Retry after 2026-10-20T12:00:30.000Z.",
        retryAt: 1_030_000,
      },
      { ok: true, doc: doc() },
    ],
  });
  expect(t.d.body.dataset["state"]).toBe("error");
  expect(t.q("problem").hidden).toBe(false);
  expect(t.q("problem-message").textContent).toBe("Reddit rate limit.");
  expect(t.q("problem-retry").textContent).toBe("Retry in 30 s.");
  expect(t.q("refresh").textContent).toBe("Retry");
  expect((t.q("refresh") as HTMLButtonElement).disabled).toBe(true);
  expect((t.q("copy") as HTMLButtonElement).disabled).toBe(true);
  t.clock.now = 1_030_000;
  await t.flush();
  expect((t.q("refresh") as HTMLButtonElement).disabled).toBe(false);
  (t.q("refresh") as HTMLButtonElement).click();
  await t.flush();
  expect(t.d.body.dataset["state"]).toBe("ready");
  expect(t.q("problem").hidden).toBe(true);
  expect(t.q("refresh").textContent).toBe("Refresh");
});

test("a stale reply after a newer request is ignored", async () => {
  const pending: Array<(v: unknown) => void> = [];
  const t = await setup({
    send: () => new Promise((resolve) => pending.push(resolve)),
  });
  expect(t.d.body.dataset["state"]).toBe("loading");
  (t.q("refresh") as HTMLButtonElement).disabled = false;
  (t.q("refresh") as HTMLButtonElement).click();
  expect(pending.length).toBe(2);
  pending[0]?.({ ok: true, doc: doc({ title: "stale" }, 3) });
  await new Promise((r) => setTimeout(r, 0));
  expect(t.d.body.dataset["state"]).toBe("loading");
  pending[1]?.({ ok: true, doc: doc() });
  await new Promise((r) => setTimeout(r, 0));
  expect(t.d.body.dataset["state"]).toBe("ready");
  expect(t.q("n-items").textContent).toBe("1");
});

test("a superseded reply for the current request shows an error", async () => {
  const t = await setup({
    replies: [{ ok: false, code: "superseded", message: "x", aborted: true }],
  });
  expect(t.d.body.dataset["state"]).toBe("error");
  expect(t.q("problem-message").textContent).toContain("Retry");
  expect((t.q("refresh") as HTMLButtonElement).disabled).toBe(false);
});

test("option change blocks Copy and Save until the recapture lands", async () => {
  const t = await setup();
  const scope = t.q<HTMLSelectElement>("scope");
  scope.value = "page";
  t.change(scope);
  expect(t.d.body.dataset["state"]).toBe("loading");
  expect((t.q("copy") as HTMLButtonElement).disabled).toBe(true);
  expect((t.q("save") as HTMLButtonElement).disabled).toBe(true);
  await t.flush();
  expect((t.q("copy") as HTMLButtonElement).disabled).toBe(false);
});

test("clipboard rejection is reported on the button", async () => {
  const t = await setup({ clipboardFails: true });
  (t.q("copy") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0));
  expect(t.q("copy").textContent).toBe("Copy failed");
  await t.flush();
  expect(t.q("copy").textContent).toBe("Copy");
});

test("no active tab is stated and disables actions", async () => {
  const t = await setup({ tabs: [] });
  expect(t.d.body.dataset["state"]).toBe("unsupported");
  expect(t.q("problem-message").textContent).toBe("No active tab to export.");
  expect(t.sent.length).toBe(0);
});

test("preview is capped for large exports; copy stays full", async () => {
  const big = doc({}, 1);
  big.blocks = [{ type: "paragraph", text: "x".repeat(300_000) }];
  const t = await setup({
    stored: { advanced: true },
    replies: [{ ok: true, doc: big }],
  });
  expect(t.q<HTMLTextAreaElement>("preview").value.length).toBe(200_000);
  expect(t.q("preview-note").hidden).toBe(false);
  (t.q("copy") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0));
  expect(t.clipboard[0]?.length).toBeGreaterThan(300_000);
});

test("unsupported page disables actions", async () => {
  const t = await setup({
    url: "chrome://extensions/",
    replies: [
      {
        ok: false,
        code: "unsupported_page",
        message: "This page cannot be exported.",
      },
    ],
  });
  expect(t.d.body.dataset["state"]).toBe("unsupported");
  expect(t.q("problem-message").textContent).toBe(
    "This page cannot be exported.",
  );
  for (const id of ["copy", "save", "refresh"])
    expect((t.q(id) as HTMLButtonElement).disabled).toBe(true);
});

test("empty capture is stated plainly", async () => {
  const t = await setup({ replies: [{ ok: true, doc: doc({}, 0) }] });
  expect(t.d.body.dataset["state"]).toBe("empty");
  expect(t.q("note").textContent).toContain("Nothing to export");
});

test("untrusted warning text is rendered as text", async () => {
  const t = await setup({
    replies: [
      {
        ok: true,
        doc: {
          ...doc(),
          meta: { ...doc().meta, warnings: ["<img src=x onerror=1>"] },
        },
      },
    ],
  });
  expect(t.q("note").textContent).toContain("<img");
  expect(t.q("note").querySelector("img")).toBeNull();
});

test("logic: Stack Exchange pairs answers with answers_reported", () => {
  const s = summarizeCoverage(
    doc({
      adapter: "stackexchange",
      coverage: {
        answers_captured: 3,
        answers_reported: 5,
        comments_captured: 12,
        partial: false,
      },
    }),
  );
  expect(s.itemsLabel).toBe("Answers");
  expect(s.items).toBe(3);
  expect(s.truncated).toBe(2);
  expect(
    stripRetryTime("Reddit cooldown: retry after 2026-10-20T12:00:30.000Z."),
  ).toBe("Reddit cooldown.");
});

test("logic: sanitize, options, coverage, retry", () => {
  expect(
    sanitizeSettings({ format: "x", maxBlocks: 3, redditMore: -1 }),
  ).toEqual(sanitizeSettings(undefined));
  expect(buildOptions(sanitizeSettings(undefined), false, true)).toEqual({
    scope: "auto",
    fresh: true,
  });
  const s = summarizeCoverage(
    doc({
      coverage: { comments_captured: 8, comments_reported: 10, partial: true },
    }),
  );
  expect(s.truncated).toBe(2);
  expect(s.itemsLabel).toBe("Comments");
  expect(describeRetry(1_000_000, 1_000_000)).toBe("Retry in 0 s.");
});
