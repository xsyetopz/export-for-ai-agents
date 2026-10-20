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

/**
 * Strip trailing whitespace per line (two or more spaces before a non-blank line become a `\`
 * hard break), blank out whitespace-only lines, collapse 3+ newlines to 2, drop leading blank
 * lines and trailing whitespace. Code (see `scanCode`) is left untouched.
 */
export function normalizeBody(text: string): string {
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
    let line = raw.replace(/[ \t]+$/, "");
    if (line === "") {
      blanks++;
      if (blanks <= 1) out.push("");
      continue;
    }
    blanks = 0;
    if (
      / {2,}$/.test(raw) &&
      !line.endsWith("\\") &&
      (lines[i + 1] ?? "").trim() !== ""
    )
      line += "\\";
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "").trimEnd();
}
