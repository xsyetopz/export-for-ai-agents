/** Small DOM helpers shared by the DOM-based thread adapters (Hacker News, GitHub, Stack Exchange). */

import type { Coverage, Meta } from "../model.ts";
import type { CaptureContext } from "./types.ts";

const MAX_FIELD_CHARS = 2000;

export const clean = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_CHARS);

/** Whitespace-normalized text of the first match, or "". */
export function textOf(root: ParentNode, selector: string): string {
  return clean(root.querySelector(selector)?.textContent);
}

/** Integer in `value` ("1,234 points", "-3", "1.2k" is not supported), or undefined. */
export function parseInteger(
  value: string | null | undefined,
): number | undefined {
  const match = /-?\d[\d,]*/.exec(value ?? "");
  if (!match) return undefined;
  const n = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** RFC 3339 UTC from an ISO-ish string or epoch seconds; undefined when it does not parse. */
export function isoDate(value: string | null | undefined): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  let ms: number;
  if (/^\d{9,11}$/.test(text)) ms = Number(text) * 1000;
  else {
    const normalized = text.replace(/^(\d{4}-\d\d-\d\d) (?=\d)/, "$1T");
    // Dates without a zone ("2026-10-19T10:00:00") are taken as UTC.
    const zoned =
      /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) || !/T/.test(normalized);
    ms = Date.parse(zoned ? normalized : `${normalized}Z`);
  }
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Shared meta builder. */
export function threadMeta(
  ctx: CaptureContext,
  fields: {
    adapter: string;
    title: string;
    site: string;
    canonical?: string | undefined;
    author?: string | undefined;
    published?: string | undefined;
    language?: string | undefined;
    coverage: Coverage;
    warnings: string[];
  },
): Meta {
  const meta: Meta = {
    url: ctx.url,
    title: fields.title || ctx.url,
    captured_at: new Date().toISOString(),
    adapter: fields.adapter,
    scope: "thread",
    site: fields.site,
    coverage: fields.coverage,
    content_trust: "untrusted",
  };
  if (fields.canonical) meta.canonical = fields.canonical;
  if (fields.author) meta.author = fields.author;
  if (fields.published) meta.published = fields.published;
  const lang = clean(ctx.document.documentElement?.lang);
  if (lang) meta.language = lang;
  const warnings = [...new Set(fields.warnings)];
  if (warnings.length) meta.warnings = warnings;
  return meta;
}
