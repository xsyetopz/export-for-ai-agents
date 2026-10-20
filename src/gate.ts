/**
 * Background capture gate (design D7), separated from `background.ts` so tests can mock chrome.
 *
 * - One in-flight capture per tab; a newer request aborts the older one (latest wins, so an option
 *   change during a capture is never lost to a stale result).
 * - One Reddit request at a time across tabs, 2 s spacing stamped in storage.local, hard cooldown
 *   after a 429 (the `retryAt` is returned so the UI can show it).
 * - The bundled content script is injected with `files`, only when the tab does not answer.
 * - A timeout aborts the in-tab work through the abort message instead of leaving it running.
 */

import type { ExportDocument } from "./model.ts";
import { type ExportFormat, exportFilename, mimeFor } from "./naming.ts";
import { redditTarget } from "./reddit-url.ts";
import { toJsonl } from "./serialize/jsonl.ts";
import { toMarkdown } from "./serialize/markdown.ts";

export const POPUP_PAGE = "popup.html";
export const CONTENT_FILE = "content.js";
const COOLDOWN_KEY = "redditNextRequestAt";
const SPACING_MS = 2000;
/** A stamp this close is just waited out; further away is reported as a cooldown. */
const MAX_WAIT_MS = 2100;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Stored or reported cooldowns beyond this are ignored or clamped (storage may be tampered with). */
const MAX_COOLDOWN_MS = 3_600_000;
/** Below Chrome's 30 s idle timeout; a trivial extension API call resets it. */
const KEEPALIVE_MS = 20_000;

export interface ChromeLike {
  runtime: {
    id: string;
    getURL(path: string): string;
    getPlatformInfo(): Promise<unknown>;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string; url?: string },
          respond: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  };
  tabs: {
    get(tabId: number): Promise<{ url?: string }>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  scripting: {
    executeScript(injection: {
      target: { tabId: number };
      files: string[];
      injectImmediately?: boolean;
    }): Promise<unknown>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

export interface GateOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Injectable for tests; default globalThis timers. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type CaptureFailure = {
  ok: false;
  code: string;
  message: string;
  aborted?: boolean;
  retryAt?: number;
};

export type GateResult =
  | { ok: true; doc: ExportDocument }
  | {
      ok: true;
      text: string;
      filename: string;
      mime: string;
      meta: ExportDocument["meta"];
    }
  | CaptureFailure;

const fail = (
  code: string,
  message: string,
  extra: Partial<CaptureFailure> = {},
): CaptureFailure => ({ ok: false, code, message, ...extra });

const isHttp = (url: string | undefined): url is string => {
  try {
    const { protocol } = new URL(url ?? "");
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const sameDocument = (a: string, b: string): boolean =>
  a.split("#", 1)[0] === b.split("#", 1)[0];

/** Thrown when executeScript itself fails; `unscriptable` for pages extensions cannot touch. */
class InjectionError extends Error {
  readonly unscriptable: boolean;
  constructor(cause: unknown) {
    const text = cause instanceof Error ? cause.message : String(cause);
    super(text);
    this.unscriptable =
      /cannot be scripted|cannot access|extensions gallery|missing host permission|chrome:\/\/|chrome web store/i.test(
        text,
      );
  }
}

const needsInjection = (error: unknown): boolean =>
  /receiving end does not exist|could not establish connection/i.test(
    error instanceof Error ? error.message : String(error),
  );

export function serialize(
  doc: ExportDocument,
  format: ExportFormat,
): { text: string; filename: string; mime: string } {
  return {
    text: format === "md" ? toMarkdown(doc) : toJsonl(doc),
    filename: exportFilename(doc.meta.url, doc.meta.captured_at, format),
    mime: mimeFor(format),
  };
}

export function createGate(chromeApi: ChromeLike, options: GateOptions = {}) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimer =
    options.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearTimer =
    options.clearInterval ??
    ((handle) => globalThis.clearInterval(handle as never));
  const inflight = new Map<number, { superseded: boolean }>();
  /** Reddit slot, owned by a request (not a tab) so a superseded request cannot free it. */
  let redditOwner: { tabId: number; token: object } | null = null;
  let active = 0;
  let keepAlive: unknown;

  async function sendCapture(tabId: number, message: unknown) {
    const send = () => chromeApi.tabs.sendMessage(tabId, message);
    try {
      return await send();
    } catch (error) {
      if (!needsInjection(error)) throw error;
      try {
        await chromeApi.scripting.executeScript({
          target: { tabId },
          files: [CONTENT_FILE],
          injectImmediately: true,
        });
      } catch (injectError) {
        throw new InjectionError(injectError);
      }
      return send();
    }
  }

  /** Reddit spacing and cooldown. Returns a failure when the caller must not proceed. */
  async function redditGate(): Promise<CaptureFailure | null> {
    const stored = (await chromeApi.storage.local.get(COOLDOWN_KEY))[
      COOLDOWN_KEY
    ];
    let next = typeof stored === "number" ? stored : 0;
    if (next - now() > MAX_COOLDOWN_MS) next = 0;
    const wait = next - now();
    if (wait > MAX_WAIT_MS)
      return fail(
        "rate_limited",
        `Reddit cooldown: retry after ${new Date(next).toISOString()}.`,
        { retryAt: next },
      );
    if (wait > 0) await sleep(wait);
    await chromeApi.storage.local.set({ [COOLDOWN_KEY]: now() + SPACING_MS });
    return null;
  }

  const clampRetry = (retryAt: number): number =>
    Math.min(Math.max(retryAt, now()), now() + MAX_COOLDOWN_MS);

  async function storeCooldown(retryAt: number): Promise<number> {
    const clamped = clampRetry(retryAt);
    await chromeApi.storage.local.set({ [COOLDOWN_KEY]: clamped });
    return clamped;
  }

  /** Keeps the MV3 worker alive while any capture is in flight. */
  async function capture(raw: unknown): Promise<GateResult> {
    active++;
    if (active === 1)
      keepAlive = setTimer(() => {
        try {
          Promise.resolve(chromeApi.runtime.getPlatformInfo()).catch(() => {});
        } catch {
          // Extension context gone; nothing to keep alive.
        }
      }, KEEPALIVE_MS);
    try {
      return await run(raw);
    } finally {
      active--;
      if (active === 0) {
        clearTimer(keepAlive);
        keepAlive = undefined;
      }
    }
  }

  async function run(raw: unknown): Promise<GateResult> {
    const message = (typeof raw === "object" && raw !== null ? raw : {}) as {
      tabId?: unknown;
      options?: unknown;
      format?: unknown;
    };
    const { tabId } = message;
    if (typeof tabId !== "number" || !Number.isInteger(tabId))
      return fail("invalid_request", "Invalid request.");
    const format =
      message.format === "md" || message.format === "jsonl"
        ? message.format
        : undefined;
    if (message.format !== undefined && !format)
      return fail("invalid_request", "Invalid format.");

    let tab: { url?: string };
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      return fail("no_tab", "The source tab is gone.");
    }
    const url = tab.url;
    if (!isHttp(url))
      return fail("unsupported_page", "This page cannot be exported.");

    // Latest request wins: tell the tab to drop the older capture, and discard its result here.
    const older = inflight.get(tabId);
    if (older) {
      older.superseded = true;
      chromeApi.tabs.sendMessage(tabId, { type: "abort" }).catch(() => {});
    }
    const token = { superseded: false };
    inflight.set(tabId, token);
    const isReddit = redditTarget(url) !== null;
    let ownsReddit = false;
    try {
      if (isReddit) {
        if (redditOwner !== null && redditOwner.tabId !== tabId)
          return fail(
            "busy",
            "Another Reddit request is in progress. Try again when it finishes.",
          );
        redditOwner = { tabId, token };
        ownsReddit = true;
        const blocked = await redditGate();
        if (blocked) return blocked;
        if (token.superseded) return supersededResult();
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("timeout");
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      });
      let response: unknown;
      try {
        response = await Promise.race([
          sendCapture(tabId, { type: "capture", options: message.options }),
          timeout,
        ]);
      } catch (error) {
        if (error instanceof InjectionError && error.unscriptable)
          return fail(
            "unsupported_page",
            "This page cannot be exported (the browser blocks extensions on it).",
          );
        return fail(
          "no_response",
          "The source tab did not accept the capture. Reload it and try again.",
        );
      } finally {
        clearTimeout(timer);
      }
      if (response === timedOut) {
        chromeApi.tabs.sendMessage(tabId, { type: "abort" }).catch(() => {});
        return fail(
          "timeout",
          "The source tab did not respond in time. It may be busy; reload it and try again.",
        );
      }
      const reply = response as {
        ok?: boolean;
        doc?: ExportDocument;
        code?: string;
        message?: string;
        aborted?: boolean;
        retryAt?: number;
      } | null;
      // Store any cooldown first: a superseded reply still carries Reddit's back-off.
      let retryAt: number | undefined;
      if (isReddit) {
        const hinted = reply?.doc?.meta.coverage?.["retry_at"];
        if (reply?.code === "rate_limited" && typeof reply.retryAt === "number")
          retryAt = await storeCooldown(reply.retryAt);
        else if (reply?.ok && typeof hinted === "number")
          await storeCooldown(hinted);
      }
      if (token.superseded) return supersededResult();
      if (!reply?.ok || !reply.doc) {
        if (retryAt !== undefined)
          return fail(
            "rate_limited",
            `Reddit rate limit. Retry after ${new Date(retryAt).toISOString()}.`,
            { retryAt },
          );
        return fail(
          typeof reply?.code === "string" ? reply.code : "capture_failed",
          typeof reply?.message === "string"
            ? reply.message
            : "No response from the source tab.",
          reply?.aborted ? { aborted: true } : {},
        );
      }

      try {
        const after = await chromeApi.tabs.get(tabId);
        if (!after.url || !sameDocument(after.url, url))
          return fail(
            "tab_changed",
            "The source tab navigated during the capture. Export again.",
          );
      } catch {
        return fail("no_tab", "The source tab is gone.");
      }
      if (!format) return { ok: true, doc: reply.doc };
      return {
        ok: true,
        meta: reply.doc.meta,
        ...serialize(reply.doc, format),
      };
    } finally {
      if (inflight.get(tabId) === token) inflight.delete(tabId);
      if (ownsReddit && redditOwner?.token === token) {
        redditOwner = null;
        // Space the next request from when this one finished, not from when it started.
        try {
          const stored = (await chromeApi.storage.local.get(COOLDOWN_KEY))[
            COOLDOWN_KEY
          ];
          const stamp = now() + SPACING_MS;
          if (typeof stored !== "number" || stored < stamp)
            await chromeApi.storage.local.set({ [COOLDOWN_KEY]: stamp });
        } catch {
          // Storage unavailable; the pre-capture stamp still applies.
        }
      }
    }
  }

  const supersededResult = (): CaptureFailure =>
    fail("superseded", "A newer request replaced this one.", { aborted: true });

  function install(): void {
    chromeApi.runtime.onMessage.addListener((message, sender, respond) => {
      const type = (message as { type?: unknown } | null)?.type;
      if (
        type !== "capture" ||
        sender.id !== chromeApi.runtime.id ||
        sender.url?.split(/[?#]/, 1)[0] !== chromeApi.runtime.getURL(POPUP_PAGE)
      )
        return false;
      capture(message).then(respond, () =>
        respond(fail("capture_failed", "Capture failed.")),
      );
      return true;
    });
  }

  return { capture, install };
}
