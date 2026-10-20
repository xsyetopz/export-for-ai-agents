/**
 * GitHub adapter (design D6): DOM only, for issue, pull request and discussion pages. Repository
 * and file pages are not matched and fall through to generic (`.markdown-body` is plain content).
 * Targets the server-rendered timeline markup; a page without it (for example the newer React
 * issue view) raises `NotThisLayoutError` so the generic adapter takes over. Page content is untrusted.
 */

import type { Block, ExportDocument } from "../model.ts";
import { createBodyCapturer } from "./generic.ts";
import { clean, isoDate, textOf, threadMeta } from "./thread-dom.ts";
import {
  type Adapter,
  type CaptureContext,
  NotThisLayoutError,
} from "./types.ts";

const MAX_ITEMS = 5000;
const KINDS = new Set(["issues", "pull", "discussions"]);
const ID_PREFIX =
  "[id^='issuecomment-'],[id^='discussioncomment-'],[id^='discussion-'],[id^='issue-'],[id^='pullrequestreview-'],[id^='discussion_r']";
/** Copy buttons and anchors inside rendered Markdown are chrome, not content. */
const CHROME =
  "clipboard-copy,.zeroclipboard-container,.js-comment-edit-history";

export function githubTarget(
  value: string,
): { owner: string; repo: string; kind: string; number: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    const match = /^\/([^/]+)\/([^/]+)\/([a-z]+)\/(\d+)\/?$/.exec(url.pathname);
    if (!match || !KINDS.has(match[3] ?? "")) return null;
    return {
      owner: match[1] ?? "",
      repo: match[2] ?? "",
      kind: match[3] ?? "",
      number: match[4] ?? "",
    };
  } catch {
    return null;
  }
}

interface Layout {
  name: string;
  /** One element per comment, including the issue body. */
  items: string;
  body: string;
  author: string;
  date: string;
  /** Tried in order; the first with text wins. */
  title: string[];
  state: string;
  /** Hidden timeline items or a "load more" control. */
  more: string;
}

/** Classic server-rendered timeline. */
const CLASSIC: Layout = {
  name: "classic",
  items: ".timeline-comment",
  body: ".comment-body",
  author:
    ".timeline-comment-header .author, .timeline-comment-header a[data-hovercard-type='user']",
  date: ".timeline-comment-header relative-time, .timeline-comment-header time-ago, .timeline-comment-header time",
  title: ["bdi.js-issue-title", "h1.gh-header-title"],
  state: ".gh-header-meta .State",
  more: ".ajax-pagination-form, .js-timeline-item .js-pagination-marker",
};

/**
 * React issue view. Hand-written from the markup as remembered, not verified against live pages:
 * if GitHub renames these test ids the adapter finds no items and generic takes over.
 */
const REACT: Layout = {
  name: "react",
  items: "[data-testid='issue-body'], .react-issue-comment",
  body: "[data-testid='markdown-body']",
  author:
    "[data-testid='issue-body-header-author'], [data-testid='comment-header'] a[data-hovercard-url*='/users/'], [data-testid='comment-header'] a[href^='/']",
  date: ":is([data-testid='issue-body-header'], [data-testid='comment-header']) :is(relative-time, time-ago, time)",
  title: ["[data-testid='issue-title'] bdi", "[data-testid='issue-title']"],
  state: "[data-testid='header-state']",
  more: "[data-testid*='load-more'], [data-testid*='timeline-load']",
};

function itemsOf(doc: Document, layout: Layout): Element[] {
  return Array.from(doc.querySelectorAll(layout.items)).filter((el) =>
    el.querySelector(layout.body),
  );
}

async function capture(ctx: CaptureContext): Promise<ExportDocument> {
  const target = githubTarget(ctx.url);
  if (!target)
    throw new NotThisLayoutError(
      "This is not a GitHub issue, PR or discussion.",
    );
  const doc = ctx.document;
  let layout = REACT;
  let nodes = itemsOf(doc, REACT);
  if (!nodes.length) {
    layout = CLASSIC;
    nodes = itemsOf(doc, CLASSIC);
  }
  if (!nodes.length)
    throw new NotThisLayoutError("No GitHub timeline comments found.");

  const bodies = createBodyCapturer(ctx, CHROME);
  bodies.checkAbort();
  const warnings: string[] = [];
  let title = "";
  for (const selector of [...layout.title, "h1"]) {
    title = textOf(doc, selector);
    if (title) break;
  }
  const blocks: Block[] = [];
  const ids = new Map<Element, { id: string; depth: number }>();
  const used = new Set<string>();
  const uniqueId = (el: Element, index: number): string => {
    // The comment's own id first; a shared ancestor id may belong to several comments.
    const own = el.matches(ID_PREFIX) ? el : el.querySelector(ID_PREFIX);
    const wrapper = own ?? el.closest(ID_PREFIX);
    const base = wrapper?.id || `${target.kind}-${target.number}-c${index}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  let postId = "";
  let comments = 0;
  let stopped = false;
  for (const [index, el] of nodes.entries()) {
    await bodies.maybeYield();
    if (index >= MAX_ITEMS || bodies.limited) {
      warnings.push("Stopped at the capture limit; the thread is partial.");
      stopped = true;
      break;
    }
    const id = uniqueId(el, index);
    const author =
      clean(el.querySelector(layout.author)?.textContent) || undefined;
    const date = isoDate(
      el.querySelector(layout.date)?.getAttribute("datetime"),
    );
    const content = await bodies.blocks(
      el.querySelector(layout.body) as Element,
    );
    const common = {
      id,
      ...(author ? { author } : {}),
      ...(date ? { date } : {}),
      ...(content.length ? { content } : {}),
    };
    if (index === 0) {
      ids.set(el, { id, depth: 0 });
      postId = id;
      blocks.push({
        type: "post",
        parent_id: null,
        depth: 0,
        ...(title ? { title } : {}),
        ...common,
      });
      continue;
    }
    // Discussion replies are nested inside their parent's comment element.
    let parentEl = el.parentElement?.closest(layout.items) ?? null;
    while (parentEl && !ids.has(parentEl))
      parentEl = parentEl.parentElement?.closest(layout.items) ?? null;
    const parent = parentEl ? ids.get(parentEl) : undefined;
    const depth = parent && parent.id !== postId ? parent.depth + 1 : 0;
    ids.set(el, { id, depth });
    blocks.push({
      type: "comment",
      parent_id: parent?.id ?? postId,
      depth,
      ...common,
    });
    comments++;
  }
  const hasMore = doc.querySelector(layout.more) !== null;
  if (hasMore)
    warnings.push(
      "The timeline has hidden items or a load-more control; only loaded comments were captured.",
    );
  if (bodies.limited)
    warnings.push("Extraction hit a size limit; some content is partial.");
  if (bodies.truncated) warnings.push("An oversized block was cut or dropped.");
  for (const w of bodies.warnings) warnings.push(w);

  const state = textOf(doc, layout.state);
  const first = blocks[0];
  const canonical = bodies.url(
    `https://github.com/${target.owner}/${target.repo}/${target.kind}/${target.number}`,
  );
  return {
    meta: threadMeta(ctx, {
      adapter: "github",
      title:
        title ||
        `${target.owner}/${target.repo} ${target.kind} ${target.number}`,
      site: `GitHub ${target.owner}/${target.repo}`,
      canonical: canonical ?? undefined,
      author: first && "author" in first ? first.author : undefined,
      published: first && "date" in first ? first.date : undefined,
      coverage: {
        loaded_content_only: true,
        kind: target.kind,
        layout: layout.name,
        comments_captured: comments,
        state: state || null,
        partial: stopped || hasMore || bodies.limited || bodies.truncated,
      },
      warnings,
    }),
    blocks,
  };
}

export const githubAdapter: Adapter = {
  id: "github",
  matches: (url) => githubTarget(url) !== null,
  capture,
};
