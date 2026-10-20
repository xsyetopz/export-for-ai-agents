/**
 * Hacker News adapter (design D6): DOM only, `news.ycombinator.com/item?id=`. Comment nesting is
 * derived from `td.ind[indent]`. Bodies go through the generic converter. Page content is untrusted.
 */

import type { Block, ContentBlock, ExportDocument } from "../model.ts";
import { createBodyCapturer } from "./generic.ts";
import {
  clean,
  isoDate,
  parseInteger,
  textOf,
  threadMeta,
} from "./thread-dom.ts";
import {
  type Adapter,
  type CaptureContext,
  NotThisLayoutError,
} from "./types.ts";

const MAX_ITEMS = 5000;

export function hackerNewsId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "news.ycombinator.com")
      return null;
    if (url.pathname !== "/item") return null;
    const id = url.searchParams.get("id");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** `title="2026-10-19T10:00:00 1760868000"` carries an ISO time and epoch seconds. */
function ageDate(row: ParentNode): string | undefined {
  const title = row.querySelector(".age")?.getAttribute("title");
  if (!title) return undefined;
  const [iso, epoch] = title.split(/\s+/);
  return isoDate(epoch) ?? isoDate(iso);
}

function indentOf(row: Element): number {
  const cell = row.querySelector("td.ind");
  const attr = Number(cell?.getAttribute("indent"));
  if (Number.isInteger(attr) && attr >= 0) return attr;
  // Older markup only has the spacer image, 40px per level.
  const width = Number(cell?.querySelector("img")?.getAttribute("width"));
  return Number.isFinite(width) && width > 0 ? Math.round(width / 40) : 0;
}

async function capture(ctx: CaptureContext): Promise<ExportDocument> {
  const doc = ctx.document;
  if (!hackerNewsId(ctx.url))
    throw new NotThisLayoutError("This is not a Hacker News item page.");
  // A comment permalink shows the comment itself in the fat item, with a link to its story.
  const story =
    doc.querySelector(".fatitem tr.athing") ??
    doc.querySelector("tr.athing:not(.comtr)");
  if (!story?.id) throw new NotThisLayoutError("No Hacker News story found.");

  const bodies = createBodyCapturer(ctx, ".reply");
  bodies.checkAbort();
  const warnings: string[] = [];
  const blocks: Block[] = [];

  const titleLink = story.querySelector(".titleline > a, a.storylink");
  const title =
    clean(titleLink?.textContent) || textOf(doc, ".fatitem .onstory a");
  const target = bodies.url(titleLink?.getAttribute("href"));
  const subtext = doc.querySelector(".fatitem .subtext");
  const head: ParentNode = subtext ?? story;
  const author = textOf(head, ".hnuser") || undefined;
  const date = ageDate(head);
  const score = subtext ? parseInteger(textOf(subtext, ".score")) : undefined;
  const content: ContentBlock[] = [];
  // Ask/Show HN titles link to the item itself; only an outside link is worth keeping.
  if (target && !/\/\/news\.ycombinator\.com\/item\?/.test(target))
    content.push({ type: "link", url: target, text: title || target });
  const top =
    doc.querySelector(".fatitem .toptext") ??
    doc.querySelector(".fatitem .commtext");
  if (top) content.push(...(await bodies.blocks(top)));
  blocks.push({
    type: "post",
    id: story.id,
    parent_id: null,
    depth: 0,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(date ? { date } : {}),
    ...(content.length ? { content } : {}),
  });

  const rows = Array.from(doc.querySelectorAll("tr.athing.comtr")).filter(
    (row) => !row.closest(".fatitem"),
  );
  const stack: Array<{ id: string; indent: number }> = [];
  let captured = 0;
  let unavailable = 0;
  let stopped = false;
  for (const row of rows) {
    await bodies.maybeYield();
    if (!row.id) {
      unavailable++;
      continue;
    }
    if (captured >= MAX_ITEMS || bodies.limited) {
      warnings.push("Stopped at the capture limit; the thread is partial.");
      stopped = true;
      break;
    }
    const text = row.querySelector(".commtext");
    const indent = indentOf(row);
    while (stack.length && (stack.at(-1)?.indent ?? 0) >= indent) stack.pop();
    const parent = stack.at(-1);
    if (!text) {
      // Deleted or flagged: keep a placeholder so replies still have a parent.
      unavailable++;
      blocks.push({
        type: "comment",
        id: row.id,
        parent_id: parent?.id ?? story.id,
        depth: stack.length,
        content: [{ type: "paragraph", text: "[deleted]" }],
      });
      stack.push({ id: row.id, indent });
      continue;
    }
    const commentAuthor = textOf(row, ".hnuser");
    const commentDate = ageDate(row);
    const body = await bodies.blocks(text);
    blocks.push({
      type: "comment",
      id: row.id,
      parent_id: parent?.id ?? story.id,
      depth: stack.length,
      ...(commentAuthor ? { author: commentAuthor } : {}),
      ...(commentDate ? { date: commentDate } : {}),
      ...(body.length ? { content: body } : {}),
    });
    stack.push({ id: row.id, indent });
    captured++;
  }
  if (unavailable)
    warnings.push(
      `${unavailable} comment(s) had no visible text (dead or deleted).`,
    );
  if (bodies.limited)
    warnings.push("Extraction hit a size limit; some content is partial.");
  if (bodies.truncated) warnings.push("An oversized block was cut or dropped.");
  for (const w of bodies.warnings) warnings.push(w);

  let reported: number | undefined;
  for (const link of Array.from(subtext?.querySelectorAll("a") ?? []))
    if (/\bcomments?\b/.test(link.textContent ?? ""))
      reported = parseInteger(link.textContent);
  const canonical = bodies.url(
    `https://news.ycombinator.com/item?id=${story.id}`,
  );
  return {
    meta: threadMeta(ctx, {
      adapter: "hackernews",
      title: title || "Hacker News item",
      site: "Hacker News",
      canonical: canonical ?? undefined,
      author,
      published: date,
      coverage: {
        loaded_content_only: true,
        comments_captured: captured,
        comments_unavailable: unavailable,
        comments_reported: reported ?? null,
        partial: stopped || bodies.limited || bodies.truncated,
      },
      warnings,
    }),
    blocks,
  };
}

export const hackerNewsAdapter: Adapter = {
  id: "hackernews",
  matches: (url) => hackerNewsId(url) !== null,
  capture,
};
