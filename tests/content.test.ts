import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  type ContentEnv,
  installContentScript,
  sanitizeOptions,
} from "../src/content-script.ts";

type Listener = Parameters<
  ContentEnv["runtime"]["onMessage"]["addListener"]
>[0];

function setup(html = "<main><p>hello</p></main>") {
  const win = new Window({ url: "https://example.com/p" });
  win.document.body.innerHTML = html;
  const listeners = new Set<Listener>();
  const runtime: ContentEnv["runtime"] = {
    id: "ext-id",
    onMessage: {
      addListener: (l) => void listeners.add(l),
      removeListener: (l) => void listeners.delete(l as Listener),
    },
  };
  const env: ContentEnv = {
    runtime,
    document: win.document as unknown as Document,
    url: () => "https://example.com/p",
  };
  return { win, env, listeners };
}

const send = (l: Listener, message: unknown, id = "ext-id") =>
  new Promise<unknown>((resolve) => {
    const handled = l(message, { id }, resolve);
    if (handled !== true) resolve("unhandled");
  });

test("captures on request and rejects foreign senders", async () => {
  const { env, listeners } = setup();
  installContentScript(env);
  const [l] = [...listeners];
  if (!l) throw new Error("no listener");
  expect(await send(l, { type: "capture" }, "other")).toBe("unhandled");
  expect(await send(l, { type: "bogus" })).toBe("unhandled");
  const res = (await send(l, {
    type: "capture",
    options: { scope: "page" },
  })) as {
    ok: boolean;
    doc: { blocks: unknown[] };
  };
  expect(res.ok).toBe(true);
  expect(JSON.stringify(res.doc.blocks)).toContain("hello");
});

test("a newer capture aborts the older one; abort message aborts", async () => {
  const { env, listeners } = setup(`<main>${"<p>t</p>".repeat(3000)}</main>`);
  installContentScript(env);
  const [l] = [...listeners];
  if (!l) throw new Error("no listener");
  const first = send(l, { type: "capture", options: { sliceMs: 1 } });
  const second = send(l, { type: "capture" });
  expect(((await first) as { aborted?: boolean }).aborted).toBe(true);
  expect(((await second) as { ok: boolean }).ok).toBe(true);
  const third = send(l, { type: "capture", options: { sliceMs: 1 } });
  l({ type: "abort" }, { id: "ext-id" }, () => {});
  expect(((await third) as { aborted?: boolean }).aborted).toBe(true);
});

test("re-injection tears the previous instance down", () => {
  const { env, listeners } = setup();
  installContentScript(env);
  expect(listeners.size).toBe(1);
  installContentScript(env);
  expect(listeners.size).toBe(1);
});

test("an orphan whose runtime is dead still tears down quietly", () => {
  const { env } = setup();
  const dead: ContentEnv = {
    ...env,
    runtime: {
      id: "x",
      onMessage: {
        addListener: () => {},
        removeListener: () => {
          throw new Error("Extension context invalidated.");
        },
      },
    },
  };
  installContentScript(dead);
  expect(() => installContentScript(env)).not.toThrow();
});

test("options are sanitized", () => {
  expect(
    sanitizeOptions({
      scope: "evil",
      controls: "yes",
      maxNodes: Number.NaN,
      maxBlocks: -1,
      sliceMs: 5.7,
      extra: 1,
    }),
  ).toEqual({ sliceMs: 5 });
  expect(sanitizeOptions(null)).toEqual({});
  expect(sanitizeOptions({ scope: "selection", controls: true })).toEqual({
    scope: "selection",
    controls: true,
  });
});

test("a selection capture uses generic even on a site adapter's page", async () => {
  const { env, listeners } = setup();
  installContentScript({
    ...env,
    url: () => "https://www.reddit.com/r/test/comments/abc123/x/",
  });
  const [l] = [...listeners];
  if (!l) throw new Error("no listener");
  const res = (await send(l, {
    type: "capture",
    options: { scope: "selection" },
  })) as { ok: boolean; code?: string };
  expect(res).toMatchObject({ ok: false, code: "empty_selection" });
});
