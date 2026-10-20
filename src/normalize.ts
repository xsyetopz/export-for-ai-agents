/** Shared body-text normalizer for adapters that produce native Markdown bodies. */

const FENCE = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})(.*)$/;
const INDENTED = /^(?: {4}|\t)/;

interface CodeScan {
  /** Per line: true when it is part of a fenced or indented code block (delimiters included). */
  mask: boolean[];
  /** Closing line for a fence still open at the end of the text, else null. */
  unclosed: string | null;
}

/**
 * Finds code lines. Limits, kept simple on purpose: a fence may carry any `>` / whitespace
 * prefix (including tabs and deep indents); a line indented 4+ spaces or a tab is always code
 * (even inside a list or right after a paragraph); blank lines between two indented lines
 * are code; a backtick fence's info string may not contain a backtick (so ```` ```js``` ```` is
 * not a fence).
 */
export function scanCode(lines: readonly string[]): CodeScan {
  const mask: boolean[] = new Array(lines.length).fill(false);
  const indented: boolean[] = new Array(lines.length).fill(false);
  let open: { prefix: string; marker: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const m = FENCE.exec(raw);
    if (open !== null) {
      mask[i] = true;
      if (
        m?.[2] &&
        m[2][0] === open.marker[0] &&
        m[2].length >= open.marker.length &&
        (m[3] ?? "").trim() === ""
      )
        open = null;
      continue;
    }
    if (m?.[2] && !(m[2][0] === "`" && (m[3] ?? "").includes("`"))) {
      mask[i] = true;
      open = { prefix: m[1] ?? "", marker: m[2] };
      continue;
    }
    if (raw.trim() !== "" && INDENTED.test(raw)) {
      mask[i] = true;
      indented[i] = true;
    }
  }
  const nextOf: boolean[] = new Array(lines.length).fill(false);
  let nextIndented = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").trim() !== "") nextIndented = indented[i] ?? false;
    else nextOf[i] = nextIndented;
  }
  let prevIndented = false;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== "") prevIndented = indented[i] ?? false;
    else if (!mask[i] && prevIndented && nextOf[i]) mask[i] = true;
  }
  return {
    mask,
    unclosed: open ? `${open.prefix}${open.marker}` : null,
  };
}

/** Closing fence line if `text` ends inside an unclosed fenced code block, else null. */
export function unclosedFence(text: string): string | null {
  return scanCode(text.replace(/\r\n?/g, "\n").split("\n")).unclosed;
}

const BLOCK_START =
  /^ {0,3}(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|>|[-+*][ \t]|\d{1,9}[.)][ \t]|(?:[-*_][ \t]*){3,}$|=+[ \t]*$|<)/;

/** Zero-width and no-break characters that count as trailing whitespace. */
function isTrailing(c: number): boolean {
  return (
    c === 0x20 ||
    c === 0x09 ||
    c === 0xa0 ||
    c === 0x200b ||
    c === 0x200c ||
    c === 0x200d ||
    c === 0xfeff
  );
}

/** Index after the last non-trailing character (linear, no regex backtracking). */
function trimmedEnd(s: string): number {
  let end = s.length;
  while (end > 0 && isTrailing(s.charCodeAt(end - 1))) end--;
  return end;
}

/** True when the line has two or more trailing spaces or NBSPs (a Markdown hard break). */
function hasBreakTail(s: string, end: number): boolean {
  let n = 0;
  for (let i = end; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0xa0) n++;
  }
  return n >= 2;
}

/** Inline code span ranges `[start, end)`; linear. An escaped opener does not start a span. */
function codeSpans(line: string): [number, number][] {
  const runs: { pos: number; len: number; open: boolean }[] = [];
  for (const m of line.matchAll(/`+/g)) {
    let bs = 0;
    for (let k = m.index - 1; k >= 0 && line[k] === "\\"; k--) bs++;
    runs.push({ pos: m.index, len: m[0].length, open: bs % 2 === 0 });
  }
  const next: number[] = new Array(runs.length).fill(-1);
  const seen = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (!r) continue;
    next[i] = seen.get(r.len) ?? -1;
    seen.set(r.len, i);
  }
  const spans: [number, number][] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const j = next[i] ?? -1;
    const c = j >= 0 ? runs[j] : undefined;
    if (r?.open && c) {
      spans.push([r.pos, c.pos + c.len]);
      i = j;
    }
  }
  return spans;
}

export interface NormalizeOptions {
  /** Origin (no trailing slash) used to resolve `](/path)` link and image targets; unset leaves them. */
  baseUrl?: string;
}

function fixProse(segment: string, baseUrl: string | undefined): string {
  let out = segment.replace(
    /(?<!\\)(\\*)<(?=[A-Za-z])/g,
    (m, slashes: string, off: number, whole: string) => {
      if (slashes.length % 2 === 1) return m;
      if (whole.slice(Math.max(0, off - 2), off) === "](") return m;
      if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(whole.slice(off + m.length)))
        return m;
      return `${slashes}\\<`;
    },
  );
  if (baseUrl !== undefined)
    out = out.replace(
      /\]\((\s*<?)\/(?!\/)/g,
      (_m, pre: string) => `](${pre}${baseUrl}/`,
    );
  return out;
}

/** Escape bare `<letter` and resolve relative link targets outside inline code spans. */
function fixInline(line: string, baseUrl: string | undefined): string {
  let out = "";
  let last = 0;
  for (const [start, end] of codeSpans(line)) {
    out += fixProse(line.slice(last, start), baseUrl);
    out += line.slice(start, end);
    last = end;
  }
  return out + fixProse(line.slice(last), baseUrl);
}

/**
 * Strip trailing whitespace per line (two or more spaces before a non-blank line become a `\`
 * hard break), blank out whitespace-only lines, collapse 3+ newlines to 2, drop leading blank
 * lines and trailing whitespace. Code (see `scanCode`) is left untouched.
 */
export function normalizeBody(
  text: string,
  options: NormalizeOptions = {},
): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const { mask } = scanCode(lines);
  const out: string[] = [];
  let blanks = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (mask[i]) {
      out.push(raw);
      blanks = 0;
      continue;
    }
    const end = trimmedEnd(raw);
    let line = raw.slice(0, end);
    if (line === "") {
      blanks++;
      if (blanks <= 1) out.push("");
      continue;
    }
    blanks = 0;
    if (
      hasBreakTail(raw, end) &&
      !line.endsWith("\\") &&
      trimmedEnd(lines[i + 1] ?? "") > 0 &&
      !BLOCK_START.test(lines[i + 1] ?? "")
    )
      line += "\\";
    out.push(fixInline(line, options.baseUrl));
  }
  return out.join("\n").replace(/^\n+/, "").trimEnd();
}
