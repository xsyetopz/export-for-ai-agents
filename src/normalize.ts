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
 * True for indented code inside block quotes: after the `>` markers (each with one optional
 * space or tab) the rest starts with 4+ spaces or a tab, followed by content. A manual loop, not
 * a regex: `(?:>[ ]?)+ {4}` would backtrack and accept `>    x` (four spaces, which is prose).
 */
function quotedIndent(raw: string): boolean {
  let i = 0;
  while (raw[i] === " " || raw[i] === "\t") i++;
  if (raw[i] !== ">") return false;
  for (;;) {
    i++; // the `>`
    if (raw[i] === " " || raw[i] === "\t") i++; // one optional space (or tab)
    let j = i;
    while (raw[j] === " ") j++;
    if (raw[j] !== ">") break;
    i = j;
  }
  let spaces = 0;
  while (raw[i + spaces] === " ") spaces++;
  if (spaces < 4 && raw[i] !== "\t") return false;
  return raw.slice(i).trim() !== "";
}

/**
 * Finds code lines. Limits, kept simple on purpose: a fence may carry any `>` / whitespace
 * prefix (including tabs and deep indents); a line indented 4+ spaces or a tab is always code
 * (even inside a list or right after a paragraph); blank lines between two indented lines
 * are code; a backtick fence's info string may not contain a backtick (so ```` ```js``` ```` is
 * not a fence).
 *
 * Quote-aware: indented code inside `>` quotes counts too (see `quotedIndent`). Code in a list
 * item already sits at 4+ absolute columns, so it is covered. Trade-offs: a quoted line indented
 * 4+ right after a quoted paragraph line is code (CommonMark reads a continuation); tab handling
 * is approximate; bare `>` lines between quoted code lines are not bridged (they are only
 * trimmed); a nested list indented 4+ columns is read as code.
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
    if (raw.trim() !== "" && (INDENTED.test(raw) || quotedIndent(raw))) {
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
  // Closer view: the full run. Opener view: an escaped run of 2+ opens a shorter run after the
  // backslash; an escaped single backtick opens nothing (openLen 0).
  const runs: { pos: number; len: number; openPos: number; openLen: number }[] =
    [];
  for (const m of line.matchAll(/`+/g)) {
    let bs = 0;
    for (let k = m.index - 1; k >= 0 && line[k] === "\\"; k--) bs++;
    const len = m[0].length;
    const escaped = bs % 2 === 1;
    runs.push({
      pos: m.index,
      len,
      openPos: escaped ? m.index + 1 : m.index,
      openLen: escaped ? len - 1 : len,
    });
  }
  const next: number[] = new Array(runs.length).fill(-1);
  const seen = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (!r) continue;
    next[i] = r.openLen > 0 ? (seen.get(r.openLen) ?? -1) : -1;
    seen.set(r.len, i);
  }
  const spans: [number, number][] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const j = next[i] ?? -1;
    const c = j >= 0 ? runs[j] : undefined;
    if (r && c) {
      spans.push([r.openPos, c.pos + c.len]);
      i = j;
    }
  }
  return spans;
}

export interface NormalizeOptions {
  /** Origin (no trailing slash) used to resolve `](/path)` link and image targets; unset leaves them. */
  baseUrl?: string;
}

function fixProse(
  segment: string,
  baseUrl: string | undefined,
  base: number,
  keep: ReadonlySet<number>,
): string {
  let out = segment.replace(
    /(?<!\\)(\\*)<(?=[A-Za-z]|\/[A-Za-z])/g,
    (m, slashes: string, off: number, whole: string) => {
      if (slashes.length % 2 === 1) return m;
      if (keep.has(base + off + slashes.length)) return m;
      let k = off;
      while (k > 0 && (whole[k - 1] === " " || whole[k - 1] === "\t")) k--;
      if (k > 0 && whole[k - 1] === "\n") {
        k--;
        while (k > 0 && (whole[k - 1] === " " || whole[k - 1] === "\t")) k--;
      }
      if (k >= 2 && whole[k - 1] === "(" && whole[k - 2] === "]") return m;
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
function fixInline(
  text: string,
  baseUrl: string | undefined,
  keep: ReadonlySet<number>,
): string {
  let out = "";
  let last = 0;
  for (const [start, end] of codeSpans(text)) {
    out += fixProse(text.slice(last, start), baseUrl, last, keep);
    out += text.slice(start, end);
    last = end;
  }
  return out + fixProse(text.slice(last), baseUrl, last, keep);
}

const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const QUOTE_ONLY = /^ {0,3}(?:>[ \t]*)+$/;
const QUOTE_START = /^ {0,3}>/;
/** A link reference definition line; the match ends with `<` when the destination opens with it. */
const DEFINITION =
  /[ ]{0,3}(?:>[ \t]*)*\[(?:[^[\]\\]|\\.){1,999}\]:(?:[ \t]*(?:\n[ \t]*)?<)?/y;

const HTML_BLOCK_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
/** CommonMark HTML block openers of types 1-6 (type 7 cannot interrupt a paragraph); needs the `i` flag, except CDATA, which is case-sensitive. */
const HTML_OPEN = `<(?:(?:script|pre|style|textarea)(?:[ \\t>]|$)|!--|\\?|![a-z]|(?-i:!\\[CDATA\\[)|\\/?(?:${HTML_BLOCK_NAMES})(?:[ \\t]|\\/?>|$))`;
/** Lines that can interrupt a paragraph (CommonMark): non-empty list items (ordered only from 1), HTML types 1-6. */
const INTERRUPT = new RegExp(
  `^ {0,3}(?:\`{3,}|~{3,}|#{1,6}(?:[ \\t]|$)|>|[-+*][ \\t]+[^ \\t]|1[.)][ \\t]+[^ \\t]|(?:[-*_][ \\t]*){3,}$|[=-]+[ \\t]*$|${HTML_OPEN})`,
  "i",
);
/** Any non-empty ordered item; inside a list it blocks a `\` hard break even when it does not start at 1. */
const ORDERED_ITEM = /^ {0,3}\d{1,9}[.)][ \t]+[^ \t]/;
/** A list item marker line, which opens a list context (bullet, or ordered of any number). */
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+[^ \t]/;

/**
 * True when a `\` hard break is blocked before `next`: it can interrupt a paragraph, or (inside a
 * list) is any ordered item. A `<letter` line that is not an HTML block start (or is type 7) is
 * paragraph continuation text in CommonMark, so it keeps the break.
 */
function blocksBreak(next: string, inList: boolean): boolean {
  return INTERRUPT.test(next) || (inList && ORDERED_ITEM.test(next));
}

const THEMATIC = /^ {0,3}(?:[-*_][ \t]*){3,}$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const EMPTY_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])$/;

/** Leading quote markers and at most one list marker; the list marker needs content after it. */
const CONTAINER = /^ {0,3}(?:>[ \t]?)*(?:((?:[-+*]|\d{1,9}[.)])[ \t]+))?/;

/**
 * True for a trimmed line that is itself a block marker, so a `\` hard break would become literal
 * text in it: ATX heading, thematic break, setext underline or quote-only line. An empty list item
 * counts only as the first line of a group (`first`); mid-paragraph it is plain text. The same
 * markers count after container prefixes (`> # h`, `- # h`, `> ---`); a setext underline is not
 * looked for after a list marker (`- ===` is item text) and a bare marker needs content after it.
 */
function noBreakLine(line: string, first: boolean): boolean {
  if (
    ATX.test(line) ||
    THEMATIC.test(line) ||
    SETEXT_UNDERLINE.test(line) ||
    QUOTE_ONLY.test(line) ||
    (first && EMPTY_ITEM.test(line))
  )
    return true;
  const m = CONTAINER.exec(line);
  if (!m || m[0] === "") return false;
  const rest = line.slice(m[0].length);
  return (
    ATX.test(rest) ||
    THEMATIC.test(rest) ||
    (m[1] === undefined && SETEXT_UNDERLINE.test(rest)) ||
    (first && EMPTY_ITEM.test(rest))
  );
}

/** True for a trimmed line that is a link reference definition line (a `[label]:` start). */
function isDefinition(trim: string): boolean {
  DEFINITION.lastIndex = 0;
  return DEFINITION.test(trim);
}

/**
 * True for a trimmed line that ends in `](` or is a bare `[label]:`; its next line is the
 * destination. A bare `[label]:` counts only where a definition can be (`defOk`: at a group start
 * or right after another definition line).
 */
function opensDestination(trim: string, defOk: boolean): boolean {
  if (trim.endsWith("](")) return true;
  if (!defOk) return false;
  DEFINITION.lastIndex = 0;
  const def = DEFINITION.exec(trim);
  return !!def && def[0].endsWith(":") && def[0].length === trim.length;
}

/** True when `raw` (line `idx`) starts a new paragraph group rather than continuing the previous line's. */
function startsGroup(
  lines: readonly string[],
  idx: number,
  prevDefOk: boolean,
): boolean {
  const raw = lines[idx] ?? "";
  const prev = lines[idx - 1] ?? "";
  const prevTrim = prev.slice(0, trimmedEnd(prev));
  const trim = raw.slice(0, trimmedEnd(raw));
  if (ATX.test(prevTrim) || QUOTE_ONLY.test(prevTrim)) return true;
  if (opensDestination(prevTrim, prevDefOk)) return false;
  if (QUOTE_ONLY.test(trim)) return true;
  if (QUOTE_START.test(raw)) return !QUOTE_START.test(prev);
  return INTERRUPT.test(raw);
}

const NO_KEEP: ReadonlySet<number> = new Set();

/** Offsets of the `<` that open reference definition destinations at the start of a group. */
function definitionDestinations(text: string): Set<number> {
  const keep = new Set<number>();
  let start = 0;
  while (start <= text.length) {
    DEFINITION.lastIndex = start;
    const m = DEFINITION.exec(text);
    if (!m) break;
    if (m[0].endsWith("<")) keep.add(start + m[0].length - 1);
    const nl = text.indexOf("\n", start);
    if (nl < 0) break;
    start = nl + 1;
  }
  return keep;
}

/** Normalize lines `[from, to)`: one paragraph group, so code spans may cross its line breaks. */
function normalizeGroup(
  lines: readonly string[],
  from: number,
  to: number,
  baseUrl: string | undefined,
  inList: boolean,
): string {
  if (to - from === 1) {
    const raw = lines[from] ?? "";
    const line = raw.slice(0, trimmedEnd(raw));
    if (!line.includes("`")) {
      const next = lines[from + 1] ?? "";
      const text =
        hasBreakTail(raw, line.length) &&
        !line.endsWith("\\") &&
        !noBreakLine(line, true) &&
        !opensDestination(line, true) &&
        trimmedEnd(next) > 0 &&
        !blocksBreak(next, inList)
          ? `${line}\\`
          : line;
      const keep = text.includes("]:") ? definitionDestinations(text) : NO_KEEP;
      return fixProse(text, baseUrl, 0, keep);
    }
  }
  const trimmed: string[] = [];
  for (let i = from; i < to; i++) {
    const raw = lines[i] ?? "";
    trimmed.push(raw.slice(0, trimmedEnd(raw)));
  }
  const spans = codeSpans(trimmed.join("\n"));
  let s = 0;
  let offset = 0;
  let defOk = true;
  for (let i = from; i < to; i++) {
    const line = trimmed[i - from] ?? "";
    offset += line.length;
    while (s < spans.length && (spans[s]?.[1] ?? 0) <= offset) s++;
    const inSpan = s < spans.length && (spans[s]?.[0] ?? offset + 1) <= offset;
    const next = lines[i + 1] ?? "";
    if (
      !inSpan &&
      hasBreakTail(lines[i] ?? "", line.length) &&
      !line.endsWith("\\") &&
      !noBreakLine(line, i === from) &&
      !opensDestination(line, defOk) &&
      trimmedEnd(next) > 0 &&
      !blocksBreak(next, inList)
    )
      trimmed[i - from] = `${line}\\`;
    defOk = defOk && isDefinition(line);
    offset++;
  }
  const text = trimmed.join("\n");
  return fixInline(text, baseUrl, definitionDestinations(text));
}

/**
 * Strip trailing whitespace per line (two or more spaces before a non-blank line become a `\`
 * hard break, except inside a code span), blank out whitespace-only lines, collapse 3+ newlines
 * to 2, drop leading blank lines and trailing whitespace. Code (see `scanCode`) is left untouched.
 * Prose is handled per paragraph group, so inline code spans may cross line breaks.
 *
 * A hard break is skipped before a line that starts a block: list item, heading, thematic break,
 * fence, quote, setext underline, or an HTML block of types 1-6 (known tag names, comments, `<?`,
 * `<!DECL`, CDATA, script/pre/style/textarea, matched case-insensitively). Other `<letter` lines
 * (including type 7, a lone complete tag) are paragraph continuation text and keep the break.
 *
 * An ordered item counts as a block start only from 1 (`1.` or `1)`), since only that can
 * interrupt a paragraph; `a  \n2. b` keeps its break. Inside a list (the group follows a list
 * item, directly or through indented continuation) any ordered item blocks the break.
 *
 * Remaining approximations: a group ends at a line that can interrupt a paragraph (HTML block
 * types 1-6, ordered list from 1); trailing whitespace inside a multi-line span is stripped,
 * where CommonMark keeps it; a reference definition (and a bare `[label]:` line that opens a
 * destination) counts only at a group start or after another definition line, so a destination
 * on the next line followed by another definition has its later `<` escaped.
 *
 * `a  \n01) b` keeps the break (matches micromark: only a literal `1` interrupts a paragraph);
 * cmark treats `01)` as interrupting, so the `\` shows literally there.
 *
 * Known limits: only tag openers are escaped (`<x` and the closing `</x`); comment, CDATA,
 * `<?` and `<!X` openers stay unescaped. Quoted lines never take a hard break (`> a  \n> b`
 * gives `> a` then `> b`). A line indented 4+ columns is code even inside a list, so a nested
 * list indented that far is left untouched.
 */
export function normalizeBody(
  text: string,
  options: NormalizeOptions = {},
): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const { mask } = scanCode(lines);
  const out: string[] = [];
  let blanks = 0;
  let inList = false;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    if (mask[i]) {
      out.push(raw);
      blanks = 0;
      i++;
      continue;
    }
    if (trimmedEnd(raw) === 0) {
      blanks++;
      if (blanks <= 1) out.push("");
      i++;
      continue;
    }
    blanks = 0;
    if (LIST_ITEM.test(raw)) inList = true;
    else if (!/^(?: {2,}|\t)/.test(raw)) inList = false;
    let j = i + 1;
    let defOk = isDefinition(raw.slice(0, trimmedEnd(raw)));
    while (
      j < lines.length &&
      !mask[j] &&
      trimmedEnd(lines[j] ?? "") > 0 &&
      !startsGroup(lines, j, defOk)
    ) {
      const l = lines[j] ?? "";
      defOk = defOk && isDefinition(l.slice(0, trimmedEnd(l)));
      j++;
    }
    out.push(normalizeGroup(lines, i, j, options.baseUrl, inList));
    i = j;
  }
  return out.join("\n").replace(/^\n+/, "").trimEnd();
}
