/** Adapter contract (design D6). */

import type { ExportDocument } from "../model.ts";

export type CaptureScope = "auto" | "page" | "selection";

export interface CaptureOptions {
  /** "auto" picks main content, "page" the whole body, "selection" the user's selection. */
  scope?: CaptureScope;
  /** Emit button controls as blocks. */
  controls?: boolean;
  /** Visit-count cap; every element and text node counts. Default 100000. */
  maxNodes?: number;
  /** Block cap. Default 20000. */
  maxBlocks?: number;
  /** Time slice before yielding to the page, in ms. Default 8. */
  sliceMs?: number;
  /** Reddit comment sort. Default "confidence". */
  redditSort?: "confidence" | "top" | "new" | "old" | "controversial" | "qa";
  /** Max morechildren requests (100 comments each); 0 disables expansion. Default 5. */
  redditMore?: number;
  /** Bypass the in-tab thread cache. */
  fresh?: boolean;
}

export interface CaptureContext {
  document: Document;
  url: string;
  options: CaptureOptions;
  /** Abort token: capture throws CaptureAbortedError once it is aborted. */
  signal?: AbortSignal;
  /** Gives the tab a turn between time slices. Default: scheduler.yield or setTimeout(0). */
  yieldFn?: () => Promise<void>;
  /** Clock in ms for time slicing. Default performance.now. */
  now?: () => number;
}

export interface Adapter {
  id: string;
  matches(url: string): boolean;
  capture(ctx: CaptureContext): Promise<ExportDocument>;
}

/** Base class so callers can branch on `code` without instanceof across bundles. */
export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * The page does not have the layout a site adapter expects. This is the only error after which a
 * site adapter may fall back to the generic adapter; never fall back for rate limit, busy, or timeout.
 */
export class NotThisLayoutError extends AdapterError {
  constructor(message = "This page does not have the expected layout.") {
    super("not_this_layout", message);
  }
}

/** The site asked us to back off. `retryAt` is epoch ms; never a reason to fall back to generic. */
export class RateLimitedError extends AdapterError {
  readonly retryAt: number;
  constructor(retryAt: number, message = "The site rate limit was hit.") {
    super("rate_limited", message);
    this.retryAt = retryAt;
  }
}

export class CaptureAbortedError extends AdapterError {
  constructor(message = "Capture was aborted.") {
    super("aborted", message);
  }
}

export class EmptySelectionError extends AdapterError {
  constructor(
    message = "Select text in the source page before exporting a selection.",
  ) {
    super("empty_selection", message);
  }
}

export function isNotThisLayout(error: unknown): error is NotThisLayoutError {
  return error instanceof AdapterError && error.code === "not_this_layout";
}
