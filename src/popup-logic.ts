/** Pure popup logic (design D9): settings, capture options, coverage summary. No DOM, no chrome. */

import type { CaptureOptions } from "./adapters/types.ts";
import type { ExportDocument } from "./model.ts";
import type { ExportFormat } from "./naming.ts";
import { redditTarget } from "./reddit-url.ts";

export const SETTINGS_KEY = "popupSettings";
export const DEBOUNCE_MS = 300;

export const SCOPES = ["auto", "page", "selection"] as const;
export const REDDIT_SORTS = [
  "confidence",
  "top",
  "new",
  "old",
  "controversial",
  "qa",
] as const;
/** Block caps offered in the UI; null is the backend default (20,000). */
export const BUDGETS = [1000, 5000, 50_000] as const;
export const MAX_REDDIT_MORE = 20;
const DEFAULT_REDDIT_MORE = 5;

export interface Settings {
  format: ExportFormat;
  advanced: boolean;
  scope: (typeof SCOPES)[number];
  /** Block cap, or null for the backend default. */
  maxBlocks: number | null;
  redditSort: (typeof REDDIT_SORTS)[number];
  redditMore: number;
}

export const DEFAULT_SETTINGS: Settings = {
  format: "md",
  advanced: false,
  scope: "auto",
  maxBlocks: null,
  redditSort: "confidence",
  redditMore: DEFAULT_REDDIT_MORE,
};

/** Stored data may be missing or tampered with: keep only valid fields. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const out = { ...DEFAULT_SETTINGS };
  if (input["format"] === "md" || input["format"] === "jsonl")
    out.format = input["format"];
  if (typeof input["advanced"] === "boolean") out.advanced = input["advanced"];
  const scope = SCOPES.find((s) => s === input["scope"]);
  if (scope) out.scope = scope;
  const budget = BUDGETS.find((b) => b === input["maxBlocks"]);
  if (budget) out.maxBlocks = budget;
  const sort = REDDIT_SORTS.find((s) => s === input["redditSort"]);
  if (sort) out.redditSort = sort;
  const more = input["redditMore"];
  if (
    typeof more === "number" &&
    Number.isInteger(more) &&
    more >= 0 &&
    more <= MAX_REDDIT_MORE
  )
    out.redditMore = more;
  return out;
}

export const isRedditUrl = (url: string | undefined): boolean =>
  redditTarget(url ?? "") !== null;

/** Options sent to the gate. Reddit options only travel with Reddit pages. */
export function buildOptions(
  settings: Settings,
  reddit: boolean,
  fresh: boolean,
): CaptureOptions {
  const options: CaptureOptions = { scope: settings.scope };
  if (settings.maxBlocks !== null) options.maxBlocks = settings.maxBlocks;
  if (reddit) {
    options.redditSort = settings.redditSort;
    options.redditMore = settings.redditMore;
  }
  if (fresh) options.fresh = true;
  return options;
}

export interface CoverageSummary {
  /** Label for the first number. */
  itemsLabel: string;
  items: number;
  /** Items the page reports but the capture lacks; null when unknown. */
  truncated: number | null;
  partial: boolean;
  warnings: string[];
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Reads the coverage keys the adapters emit; each captured count is paired with its own reported count. */
export function summarizeCoverage(doc: ExportDocument): CoverageSummary {
  const c = doc.meta.coverage ?? {};
  const answers = num(c["answers_captured"]);
  const comments = num(c["comments_captured"]);
  let itemsLabel = "Blocks";
  let items = num(c["blocks"]) ?? doc.blocks.length;
  let reported: number | undefined;
  let captured: number | undefined;
  if (answers !== undefined) {
    itemsLabel = "Answers";
    captured = answers;
    reported = num(c["answers_reported"]);
  } else if (comments !== undefined) {
    itemsLabel = "Comments";
    captured = comments;
    reported = num(c["comments_reported"]);
  }
  if (captured !== undefined) items = captured;
  const truncated =
    captured !== undefined && reported !== undefined
      ? Math.max(0, reported - captured)
      : null;
  return {
    itemsLabel,
    items,
    truncated,
    partial: c["partial"] === true,
    warnings: doc.meta.warnings ?? [],
  };
}

/** One plain line under the coverage row. */
export function coverageNote(summary: CoverageSummary): string {
  const parts: string[] = [];
  if (summary.truncated !== null && summary.truncated > 0)
    parts.push(
      `${summary.truncated} ${summary.itemsLabel.toLowerCase()} not captured.`,
    );
  else if (summary.partial) parts.push("Partial capture: size limit reached.");
  parts.push(...summary.warnings.slice(0, 2));
  return parts.join(" ");
}

export function isWarning(summary: CoverageSummary): boolean {
  return (
    summary.partial ||
    (summary.truncated !== null && summary.truncated > 0) ||
    summary.warnings.length > 0
  );
}

export function formatKb(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 10 ? kb.toFixed(1) : String(Math.round(kb));
}

/** "Retry in 12 s." for near times, a clock time otherwise. */
export function describeRetry(retryAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  if (seconds <= 120) return `Retry in ${seconds} s.`;
  return `Retry after ${new Date(retryAt).toLocaleTimeString()}.`;
}

/** Drops a trailing "Retry after <ISO time>" from a gate message; the popup shows its own countdown. */
export function stripRetryTime(message: string): string {
  const text = message.replace(/[:,]?\s*retry after \d{4}-\S*?$/i, "").trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
