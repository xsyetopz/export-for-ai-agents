/** Message handling for the content script, separated from `content.ts` so tests can mock chrome. */

import { genericAdapter, selectAdapter } from "./adapters/index.ts";
import {
  type Adapter,
  AdapterError,
  CaptureAbortedError,
  type CaptureContext,
  type CaptureOptions,
  isNotThisLayout,
  RateLimitedError,
} from "./adapters/types.ts";

export const TEARDOWN_EVENT = "export-for-ai-agents:teardown";

interface Runtime {
  id: string;
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: { id?: string },
        respond: (response: unknown) => void,
      ) => boolean | undefined,
    ): void;
    removeListener(listener: (...args: never[]) => unknown): void;
  };
}

export interface ContentEnv {
  runtime: Runtime;
  document: Document;
  url: () => string;
}

/** Only known option keys with sane types reach the adapter; the sender is trusted, but be strict. */
export function sanitizeOptions(raw: unknown): CaptureOptions {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const options: CaptureOptions = {};
  const scope = input["scope"];
  if (scope === "auto" || scope === "page" || scope === "selection")
    options.scope = scope;
  if (typeof input["controls"] === "boolean")
    options.controls = input["controls"];
  for (const key of ["maxNodes", "maxBlocks", "sliceMs"] as const) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0)
      options[key] = Math.floor(value);
  }
  const sort = input["redditSort"];
  if (
    sort === "confidence" ||
    sort === "top" ||
    sort === "new" ||
    sort === "old" ||
    sort === "controversial" ||
    sort === "qa"
  )
    options.redditSort = sort;
  const more = input["redditMore"];
  if (typeof more === "number" && Number.isFinite(more) && more >= 0)
    options.redditMore = Math.floor(more);
  if (typeof input["fresh"] === "boolean") options.fresh = input["fresh"];
  return options;
}

/** Site adapter first; generic only after the structural "not this layout" error. */
export async function captureWithFallback(
  adapter: Adapter,
  ctx: CaptureContext,
) {
  try {
    return await adapter.capture(ctx);
  } catch (error) {
    if (adapter.id !== genericAdapter.id && isNotThisLayout(error))
      return genericAdapter.capture(ctx);
    throw error;
  }
}

/**
 * Registers the capture listener. An older instance (double injection, or an orphan left by an
 * extension reload whose chrome.runtime is dead) is told to tear down first.
 */
export function installContentScript(env: ContentEnv): () => void {
  const view = env.document.defaultView as
    | (Window & { CustomEvent: typeof CustomEvent })
    | null;
  env.document.dispatchEvent(
    new (view?.CustomEvent ?? CustomEvent)(TEARDOWN_EVENT),
  );
  let controller: AbortController | undefined;

  const listener = (
    message: unknown,
    sender: { id?: string },
    respond: (response: unknown) => void,
  ): boolean | undefined => {
    if (sender.id !== env.runtime.id) return false;
    const type = (message as { type?: unknown } | null)?.type;
    if (type === "abort") {
      controller?.abort();
      return false;
    }
    if (type !== "capture") return false;
    controller?.abort(); // Only the latest request matters.
    const mine = new AbortController();
    controller = mine;
    const url = env.url();
    const options = sanitizeOptions((message as { options?: unknown }).options);
    // A user selection is page text; site adapters capture whole threads.
    const adapter =
      options.scope === "selection" ? genericAdapter : selectAdapter(url);
    captureWithFallback(adapter, {
      document: env.document,
      url,
      options,
      signal: mine.signal,
    })
      .then((doc) => respond({ ok: true, doc }))
      .catch((error: unknown) => {
        const known = error instanceof AdapterError;
        respond({
          ok: false,
          code: known ? error.code : "capture_failed",
          aborted: error instanceof CaptureAbortedError,
          message: known ? error.message : "Capture failed.",
          ...(error instanceof RateLimitedError
            ? { retryAt: error.retryAt }
            : {}),
        });
      });
    return true;
  };

  const teardown = () => {
    controller?.abort();
    try {
      env.runtime.onMessage.removeListener(listener);
    } catch {
      // An orphaned script outlives its extension context; nothing left to remove.
    }
    env.document.removeEventListener(TEARDOWN_EVENT, teardown);
  };
  env.document.addEventListener(TEARDOWN_EVENT, teardown);
  env.runtime.onMessage.addListener(listener);
  return teardown;
}
