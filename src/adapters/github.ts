/**
 * GitHub adapter (design D6): DOM only, for issue, pull request and discussion pages. Repository
 * and file pages are not matched and fall through to generic (`.markdown-body` is plain content).
 * Two layouts: the React issue view (`data-testid` markup) and the classic server-rendered timeline,
 * which pull requests and discussions still use (their header is React on PRs, classic on
 * discussions, so title and state try several selectors). A page with neither raises
 * `NotThisLayoutError` so the generic adapter takes over. Selectors were checked against logged-out
 * server HTML, not hydrated pages. Page content is untrusted.
 */

import type { Block, ExportDocument } from "../model.ts";
import { createBodyCapturer } from "./generic.ts";
import { MAX_JSONLD_CHARS } from "./jsonld.ts";
import { clean, isoDate, textOf, threadMeta } from "./thread-dom.ts";
import {
  type Adapter,
  type CaptureContext,
  NotThisLayoutError,
} from "./types.ts";

const ISSUE_BODY_LINK = "[data-testid='issue-body-header-link']";
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const MAX_ITEMS = 5000;
const EMBEDDED_DATA = "script[data-target='react-app.embeddedData']";
const MAX_EMBEDDED_DEPTH = 24;
const MAX_EMBEDDED_SCRIPTS = 8;
const MAX_EMBEDDED_NODES = 100_000;
const KINDS = new Set(["issues", "pull", "discussions"]);
const ID_PREFIX =
  "[id^='issuecomment-'],[id^='discussioncomment-'],[id^='discussion-'],[id^='issue-'],[id^='pullrequest-'],[id^='pullrequestreview-'],[id^='discussion_r']";
/** A full comment id; rejects descendants such as `issuecomment-1-permalink` or `discussion-edit-history-1-text`. */
const FULL_ID =
  /^(?:(?:issuecomment|discussioncomment|pullrequestreview|pullrequest|issue|discussion)-\d+|discussion_r\d+)$/;
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
  /** Tried in order; the first with text wins. */
  state: string[];
  /** Hidden timeline items or a "load more" control. */
  more: string;
}

/** Classic server-rendered timeline. */
const CLASSIC: Layout = {
  name: "classic",
  items: ".timeline-comment",
  body: ".comment-body",
  author:
    ".timeline-comment-header .author, .timeline-comment-header a[data-hovercard-type='user'], .timeline-comment-header-text a.Link--primary",
  date: ".timeline-comment-header relative-time, .timeline-comment-header time-ago, .timeline-comment-header time, .timeline-comment-header-text relative-time, .js-timestamp relative-time",
  title: ["h1 .markdown-title", "h1 .js-issue-title", "bdi.js-issue-title"],
  state: [
    "[data-component='PageHeader.Description'] [data-component='StateLabel']",
    "#discussion_bucket .State",
    ".gh-header-meta .State",
  ],
  more: ".ajax-pagination-form, .js-timeline-item .js-pagination-marker",
};

/**
 * React issue view. Verified against logged-out server HTML from 2026-10; hydration is unverified
 * (server `relative-time` has no `datetime`, so dates fall back to the text). If GitHub renames
 * these test ids the adapter finds no items and generic takes over.
 */
const REACT: Layout = {
  name: "react",
  items: "[data-testid='issue-body'], .react-issue-comment",
  body: "[data-testid='markdown-body']",
  author:
    "[data-testid='issue-body-header-author'], [data-testid='comment-header'] [data-testid='avatar-link']",
  date: "[data-testid='issue-body-header-link'] relative-time, [data-testid='comment-header'] a[href*='#issuecomment-'] relative-time",
  title: ["[data-testid='issue-title'] bdi", "[data-testid='issue-title']"],
  state: ["[data-testid='header-state']"],
  more: "[data-testid*='load-more']",
};

function itemsOf(doc: Document, layout: Layout): Element[] {
  return Array.from(doc.querySelectorAll(layout.items)).filter((el) =>
    ownMatch(el, layout.body, layout),
  );
}

/** The first match that belongs to `item` itself, not to a reply nested inside it. */
function ownMatch(item: Element, selector: string, layout: Layout) {
  for (const el of item.querySelectorAll(selector))
    if (el.closest(layout.items) === item) return el;
  return null;
}

/** Login from a profile link (`/login` or `https://github.com/login`), else the visible text. */
function authorOf(el: Element | null): string | undefined {
  if (!el) return undefined;
  const href = el.getAttribute("href");
  if (href) {
    try {
      const url = new URL(href, "https://github.com");
      const match = /^\/([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(url.pathname);
      if (url.origin === "https://github.com" && match?.[1]) return match[1];
    } catch {
      // fall through to the text
    }
  }
  return clean(el.textContent) || undefined;
}

/**
 * ISO date of a time element: `datetime`, then `title`, then text such as "on Dec 3, 2015" (what the
 * server HTML has, taken as UTC midnight). Anything that does not parse is dropped.
 */
/** Only ISO-like text with an explicit zone; zone-less strings would parse as local time. */
function zonedOnly(value: string | null): string | null {
  return value &&
    /^\d{4}-\d\d-\d\d[T ].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())
    ? value
    : null;
}

/**
 * Exact times from the React page's embedded JSON, keyed by full DOM id (`issue-N`,
 * `issuecomment-N`). The issue has no `__typename`, so it is recognised by sitting under
 * `repository.issue`; comments by `__typename: "IssueComment"`. Other timeline events share the
 * same fields and are ignored. Only issue pages carry times here: PR and discussion pages are classic
 * server HTML whose embedded data has no `createdAt`, so they use `relative-time` `datetime`. Parsed as data only; oversized or malformed scripts are skipped.
 */
function embeddedTimes(doc: Document): Map<string, string> {
  const times = new Map<string, string>();
  const add = (prefix: string, node: Record<string, unknown>) => {
    const { databaseId, createdAt } = node;
    if (!Number.isSafeInteger(databaseId) || typeof createdAt !== "string")
      return;
    const iso = isoDate(zonedOnly(createdAt));
    const key = `${prefix}-${databaseId}`;
    if (iso && !times.has(key)) times.set(key, iso);
  };
  // One node budget shared by all scripts, so many blocks cannot multiply the work.
  let seen = 0;
  const scripts = Array.from(doc.querySelectorAll(EMBEDDED_DATA)).slice(
    0,
    MAX_EMBEDDED_SCRIPTS,
  );
  for (const script of scripts) {
    if (seen >= MAX_EMBEDDED_NODES) break;
    const text = script.textContent ?? "";
    if (!text || text.length > MAX_JSONLD_CHARS) continue;
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      continue;
    }
    const stack: {
      value: unknown;
      depth: number;
      key: string;
      parent: string;
    }[] = [{ value: root, depth: 0, key: "", parent: "" }];
    while (stack.length && seen++ < MAX_EMBEDDED_NODES) {
      const { value, depth, key, parent } =
        stack.pop() as (typeof stack)[number];
      if (!value || typeof value !== "object" || depth > MAX_EMBEDDED_DEPTH)
        continue;
      if (!Array.isArray(value)) {
        const node = value as { __typename?: unknown } & Record<
          string,
          unknown
        >;
        if (node.__typename === "IssueComment") add("issuecomment", node);
        else if (key === "issue" && parent === "repository" && !node.__typename)
          add("issue", node);
      }
      const entries = Array.isArray(value)
        ? value.map((v, i) => [String(i), v] as const)
        : Object.entries(value);
      for (const [k, v] of entries)
        stack.push({ value: v, depth: depth + 1, key: k, parent: key });
    }
  }
  return times;
}

function dateOf(el: Element | null, embedded?: string): string | undefined {
  if (!el) return embedded;
  const fromDatetime = isoDate(el.getAttribute("datetime"));
  if (fromDatetime) return fromDatetime;
  if (embedded) return embedded;
  const fromTitle = isoDate(zonedOnly(el.getAttribute("title")));
  if (fromTitle) return fromTitle;
  const text = clean(el.textContent).replace(/^on\s+/i, "");
  const match = /^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}), (\d{4})$/.exec(text);
  const month = MONTHS.indexOf((match?.[1] ?? "").toLowerCase()) + 1;
  if (!match || !month) return undefined;
  const day = (match[2] ?? "").padStart(2, "0");
  // isoDate rejects rollover such as "Feb 31".
  return isoDate(`${match[3]}-${String(month).padStart(2, "0")}-${day}`);
}

/** A full comment id on `el`, an ancestor, or a descendant (in that order), or "". */
function commentId(el: Element): string {
  if (FULL_ID.test(el.id)) return el.id;
  for (let p = el.parentElement; p; p = p.parentElement)
    if (FULL_ID.test(p.id)) return p.id;
  for (const d of el.querySelectorAll(ID_PREFIX))
    if (FULL_ID.test(d.id)) return d.id;
  return "";
}

/** The React issue body has no comment id; its header link points at `#issue-N`. */
function issueBodyId(el: Element, layout: Layout): string {
  if (layout.name !== "react") return "";
  const href = ownMatch(el, ISSUE_BODY_LINK, layout)?.getAttribute("href");
  const fragment = href?.split("#")[1] ?? "";
  return FULL_ID.test(fragment) ? fragment : "";
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
  const embedded = layout.name === "react" ? embeddedTimes(doc) : new Map();
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
    const base =
      issueBodyId(el, layout) ||
      commentId(el) ||
      `${target.kind}-${target.number}-c${index}`;
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
    const author = authorOf(ownMatch(el, layout.author, layout));
    // A PR review keeps its timestamp in a wrapper around the item.
    const wrapper = el.parentElement?.closest("[id^='pullrequestreview-']");
    const review =
      wrapper && wrapper.querySelector(layout.items) === el ? wrapper : null;
    const date =
      dateOf(ownMatch(el, layout.date, layout), embedded.get(id)) ??
      dateOf(
        review?.querySelector(
          "a.js-timestamp[href^='#pullrequestreview-'] relative-time",
        ) ?? null,
      );
    const content = await bodies.blocks(
      ownMatch(el, layout.body, layout) as Element,
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

  let state = "";
  for (const selector of layout.state) {
    state = textOf(doc, selector);
    if (state) break;
  }
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
