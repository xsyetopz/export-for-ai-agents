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

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

/** True when the written Y-M-D and time are a real calendar moment, before any zone shift. */
function validParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): boolean {
  return (
    year >= 1000 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

const ISO_SHAPE =
  /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|[+-]\d\d(?::?\d\d))?)?$/i;
const RFC_SHAPE =
  /^(?:[A-Za-z]{3},\s*)?(\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d\d):(\d\d)(?::(\d\d))? (GMT|UTC|UT|Z|[+-]\d{4})$/i;
const RFC_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** RFC 3339 text for `ms`; undefined unless the UTC year is 1000..9999 (no extended or short years). */
const toIso = (ms: number): string | undefined => {
  if (!Number.isFinite(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return /^[1-9]\d{3}-/.test(iso) ? iso.replace(/\.\d{3}Z$/, "Z") : undefined;
};

/** RFC 1123/2822 date with an explicit zone, parsed by hand. A weekday name is not checked. */
function rfcDate(text: string): string | undefined {
  const m = RFC_SHAPE.exec(text);
  if (!m) return undefined;
  const month = RFC_MONTHS.indexOf((m[2] ?? "").toLowerCase()) + 1;
  const [year, day] = [Number(m[3]), Number(m[1])];
  const [hour, minute, second] = [
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  ];
  if (!month || !validParts(year, month, day, hour, minute, second))
    return undefined;
  const zone = m[7] ?? "";
  let offset = 0;
  if (/^[+-]/.test(zone)) {
    const [oh, om] = [Number(zone.slice(1, 3)), Number(zone.slice(3, 5))];
    if (oh > 23 || om > 59) return undefined;
    offset = (zone[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  return toIso(
    Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000,
  );
}

/**
 * RFC 3339 UTC, or undefined. Accepts only: epoch seconds (9-11 digits); ISO `YYYY-MM-DD` with an
 * optional `T`/space time and optional `Z`/offset (zone-less is UTC, date-only is UTC midnight); and
 * RFC 1123/2822 with an explicit zone ("Tue, 03 Dec 2015 10:00:00 GMT"). Impossible dates (Feb 30,
 * hour 24) and offsets past 23:59 are rejected before any zone shift, as is a year (written or UTC) outside 1000..9999. Anything else, including text such as "Dec 3, 2015",
 * is undefined, so nothing depends on the local time zone.
 */
export function isoDate(value: string | null | undefined): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  if (/^\d{9,11}$/.test(text)) return toIso(Number(text) * 1000);
  const normalized = text.replace(/^(\d{4}-\d\d-\d\d) (?=\d)/, "$1T");
  const m = ISO_SHAPE.exec(normalized);
  if (!m) return rfcDate(text);
  if (
    !validParts(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    )
  )
    return undefined;
  const zone = m[7] ?? "";
  if (/^[+-]/.test(zone)) {
    const digits = zone.replace(":", "");
    if (Number(digits.slice(1, 3)) > 23 || Number(digits.slice(3, 5)) > 59)
      return undefined;
  }
  return toIso(Date.parse(m[4] && !m[7] ? `${normalized}Z` : normalized));
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
