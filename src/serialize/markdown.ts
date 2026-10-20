/** Markdown serializer (design D3): CommonMark + GFM tables, YAML front matter. */

import type {
  Block,
  ContentBlock,
  CoverageValue,
  ExportDocument,
  MediaBlock,
  ThreadBlock,
} from "../model.ts";

export const MAX_QUOTE_DEPTH = 6;

/** Double-quoted YAML scalar. JSON strings are valid YAML; also escape line separators JSON leaves raw. */
export function yamlScalar(value: string | number | boolean | null): string {
  if (typeof value !== "string") return String(value);
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/\u0085/g, "\\u0085");
}

function yamlKey(key: string): string {
  return yamlScalar(key);
}

/** CommonMark line endings: CR and CRLF (and Unicode separators) become LF. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?|\u2028|\u2029/g, "\n");
}

/**
 * Escape untrusted plain text so it cannot become Markdown syntax. Newlines are kept,
 * leading whitespace is dropped (it could open an indented code block).
 * With `pipes`, every | is escaped (table cells).
 */
export function escapeMarkdown(text: string, pipes = false): string {
  return normalizeNewlines(text)
    .replace(/[\\`*_[\]<>~&]/g, "\\$&")
    .replace(pipes ? /\|/g : /(?!)/g, "\\|")
    .split("\n")
    .map((l) =>
      l
        .replace(/^[ \t]+/, "")
        .replace(/^([#>+=-])/, "\\$1")
        .replace(/^(\d+)([.)])/, "$1\\$2")
        .replace(pipes ? /(?!)/ : /^\|/, "\\|"),
    )
    .join("\n");
}

function escapeHeading(text: string): string {
  return escapeMarkdown(oneLine(text)).replace(/(#+)$/, "\\$1");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function codeSpan(text: string): string {
  const flat = oneLine(text);
  const runs = flat.match(/`+/g) ?? [];
  const longest = runs.reduce((max, r) => Math.max(max, r.length), 0);
  const ticks = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

/** Allowlist: http, https, mailto and scheme-less (relative) URLs. Returns null otherwise. */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  let flat = "";
  for (const ch of trimmed)
    if (ch.charCodeAt(0) > 0x20 && ch.charCodeAt(0) !== 0x7f) flat += ch;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(flat)?.[1];
  if (scheme !== undefined && !SAFE_SCHEMES.has(scheme.toLowerCase()))
    return null;
  // Anything that could start an entity, a scheme smuggled past the check, or break out is encoded.
  if (
    scheme === undefined &&
    /^[^/?#]*:/.test(flat.replace(/&[^;\s]*;?/g, ":"))
  )
    return null;
  let out = "";
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    const bad = code < 0x21 || code === 0x7f || /[\s<>()\\&"']/.test(ch);
    if (!bad) out += ch;
    else if (code < 0x80)
      out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    else out += encodeURIComponent(ch);
  }
  return out;
}

function link(text: string, url: string): string {
  const dest = safeUrl(url);
  const label = escapeMarkdown(oneLine(text));
  return dest === null ? label : `[${label}](${dest})`;
}

function mediaLine(block: MediaBlock): string {
  const kind = block.kind.charAt(0).toUpperCase() + block.kind.slice(1);
  const label = oneLine(block.alt ?? block.title ?? "");
  return link(label ? `${kind}: ${label}` : kind, block.url);
}

function cell(text: string): string {
  return escapeMarkdown(text, true).replace(/\n/g, "<br>");
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : pad + l))
    .join("\n");
}

function prefixLines(text: string, prefix: string): string {
  const trimmed = prefix.trimEnd();
  return text
    .split("\n")
    .map((l) => (l === "" ? trimmed : prefix + l))
    .join("\n");
}

function fence(raw: string, language?: string): string {
  const text = normalizeNewlines(raw);
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, r) => Math.max(max, r.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  const info = (language ?? "").replace(/[^A-Za-z0-9_+#.-]/g, "");
  return `${ticks}${info}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

function renderContentBlocks(blocks: ContentBlock[]): string {
  return blocks.map(renderContent).join("\n\n");
}

function renderContent(block: ContentBlock): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(block.level)} ${escapeHeading(block.text)}`;
    case "paragraph":
      return escapeMarkdown(block.text);
    case "list": {
      // CommonMark allows at most 9 digits; the value comes from untrusted pages.
      const start =
        block.start !== undefined &&
        Number.isInteger(block.start) &&
        block.start >= 0 &&
        block.start <= 999_999_999 - block.items.length
          ? block.start
          : 1;
      return block.items
        .map((item, i) => {
          const marker = block.ordered ? `${start + i}. ` : "- ";
          const pad = " ".repeat(marker.length);
          let body = escapeMarkdown(item.text);
          if (item.blocks?.length)
            body += `\n\n${renderContentBlocks(item.blocks)}`;
          return marker + indent(body, pad);
        })
        .join("\n");
    }
    case "quote":
      return prefixLines(renderContentBlocks(block.blocks), "> ");
    case "code":
      return fence(block.text, block.language);
    case "table": {
      const cols = Math.max(
        block.header.length,
        ...block.rows.map((r) => r.length),
      );
      if (cols === 0) return "";
      const row = (cells: string[]) =>
        `| ${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? "")).join(" | ")} |`;
      return [
        row(block.header),
        `| ${Array(cols).fill("---").join(" | ")} |`,
        ...block.rows.map(row),
      ].join("\n");
    }
    case "media":
      return mediaLine(block);
    case "definition":
      return `**${escapeMarkdown(oneLine(block.term))}**: ${escapeMarkdown(block.text)}`;
    case "control": {
      const label = block.label ? `: ${block.label}` : "";
      const value = block.value ? ` = ${block.value}` : "";
      return escapeMarkdown(oneLine(`${block.kind} control${label}${value}`));
    }
    case "link":
      return link(block.text, block.url);
  }
}

/** Close constructs a native body left open so it cannot swallow what follows. */
function closeNative(body: string): string {
  let out = body;
  let open: string | null = null;
  for (const l of body.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (!m?.[1]) continue;
    const mark = m[1];
    if (open === null) open = mark;
    else if (
      mark[0] === open[0] &&
      mark.length >= open.length &&
      l.trim() === mark
    )
      open = null;
  }
  if (open !== null) out += `\n${open}`;
  if (out.lastIndexOf("<!--") > out.lastIndexOf("-->")) out += "\n-->";
  for (const tag of ["pre", "script", "style", "textarea"]) {
    const opens =
      out.match(new RegExp(`<${tag}(?=[\\s>]|$)`, "gi"))?.length ?? 0;
    const closes = out.match(new RegExp(`</${tag}>`, "gi"))?.length ?? 0;
    for (let i = closes; i < opens; i++) out += `\n</${tag}>`;
  }
  return out;
}

function renderThread(block: ThreadBlock): string {
  const head: string[] = [];
  if (block.author) head.push(`**${escapeMarkdown(oneLine(block.author))}**`);
  if (block.score !== undefined) head.push(String(block.score));
  if (block.date) head.push(escapeMarkdown(oneLine(block.date)));
  if (block.id.trim()) head.push(codeSpan(block.id));
  const lines = [head.join(" · ")];
  if (block.type === "post" && block.title)
    lines.push(`**${escapeMarkdown(oneLine(block.title))}**`);
  if (block.type === "answer" && block.accepted)
    lines.push("*Accepted answer*");
  if (block.depth > MAX_QUOTE_DEPTH && block.parent_id) {
    lines.push(`reply to ${codeSpan(block.parent_id)}`);
  }
  let out = lines.join("\n");
  const body = block.body?.trim()
    ? closeNative(normalizeNewlines(block.body).trim())
    : renderContentBlocks(block.content ?? []);
  if (body) out += `\n\n${body}`;
  const levels = Math.min(Math.max(block.depth, 0), MAX_QUOTE_DEPTH);
  return levels ? prefixLines(out, "> ".repeat(levels)) : out;
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "post":
    case "comment":
    case "answer":
      return renderThread(block);
    default:
      return renderContent(block);
  }
}

function frontMatter(doc: ExportDocument): string {
  const m = doc.meta;
  const lines = [
    "---",
    `title: ${yamlScalar(m.title)}`,
    `url: ${yamlScalar(m.url)}`,
  ];
  if (m.canonical) lines.push(`canonical: ${yamlScalar(m.canonical)}`);
  lines.push(
    `captured_at: ${yamlScalar(m.captured_at)}`,
    `adapter: ${yamlScalar(m.adapter)}`,
  );
  if (m.language) lines.push(`language: ${yamlScalar(m.language)}`);
  if (m.coverage) {
    const entries = Object.entries(m.coverage);
    if (entries.length) {
      lines.push("coverage:");
      for (const [k, v] of entries)
        lines.push(`  ${yamlKey(k)}: ${yamlScalar(v as CoverageValue)}`);
    }
  }
  if (m.warnings?.length) {
    lines.push("warnings:");
    for (const w of m.warnings) lines.push(`  - ${yamlScalar(w)}`);
  }
  lines.push(`content_trust: ${yamlScalar(m.content_trust)}`, "---");
  return lines.join("\n");
}

export function toMarkdown(doc: ExportDocument): string {
  const parts = [frontMatter(doc), `# ${escapeHeading(doc.meta.title)}`];
  if (doc.meta.description) {
    parts.push(prefixLines(escapeMarkdown(doc.meta.description.trim()), "> "));
  }
  for (const block of doc.blocks) {
    const rendered = renderBlock(block);
    if (rendered) parts.push(rendered);
  }
  return `${parts.join("\n\n")}\n`;
}
