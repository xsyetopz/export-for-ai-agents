/** Export filenames and MIME types (design D5). */

export const MIME_MARKDOWN = "text/markdown;charset=utf-8";
export const MIME_JSONL = "application/jsonl";

export type ExportFormat = "md" | "jsonl";

const MAX_SLUG = 60;

export function mimeFor(format: ExportFormat): string {
  return format === "md" ? MIME_MARKDOWN : MIME_JSONL;
}

/** Lowercase ASCII slug, at most `max` chars, no leading/trailing dash. */
export function slugify(input: string, max = MAX_SLUG): string {
  let text = input;
  try {
    text = decodeURIComponent(input);
  } catch {
    // keep the raw text on malformed escapes
  }
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** `YYYYMMDDTHHMMSSZ` (ISO 8601 basic, UTC). */
export function basicTimestamp(date: Date | string): string {
  let d = new Date(date);
  if (Number.isNaN(d.getTime())) d = new Date();
  const iso = d.toISOString();
  return `${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;
}

export function exportFilename(
  url: string,
  capturedAt: Date | string,
  format: ExportFormat,
): string {
  let host = "page";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    path = parsed.pathname;
  } catch {
    // unparsable URL: fall back to a generic name
  }
  host =
    host.replace(/[^a-z0-9.-]/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "page";
  const slug = slugify(path);
  const stamp = basicTimestamp(capturedAt);
  return `${[host, slug, stamp].filter(Boolean).join("-")}.${format}`;
}
