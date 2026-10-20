/**
 * Reddit adapter (design D6, D7). Runs in the Reddit tab: same-origin `.json` fetch with the
 * tab's own credentials (no token handling), trimmed immediately so only a compact tree is kept
 * or cached. Errors are surfaced, never turned into a DOM capture; the only fallback to generic
 * is `NotThisLayoutError` (see content-script.ts). Page content is untrusted.
 */

import type { Coverage, ExportDocument, Meta, ThreadBlock } from "../model.ts";
import { normalizeBody, scanCode, unclosedFence } from "../normalize.ts";
import { redditTarget } from "../reddit-url.ts";
import {
  type Adapter,
  AdapterError,
  CaptureAbortedError,
  type CaptureContext,
  type CaptureOptions,
  NotThisLayoutError,
  RateLimitedError,
} from "./types.ts";

export type RedditSort = NonNullable<CaptureOptions["redditSort"]>;

const SORTS: ReadonlySet<string> = new Set([
  "confidence",
  "top",
  "new",
  "old",
  "controversial",
  "qa",
]);

const FETCH_TIMEOUT_MS = 15_000;
const MORE_BATCH = 100;
const DEFAULT_MORE_REQUESTS = 5;
const MAX_MORE_REQUESTS = 20;
const MORE_SPACING_MS = 1000;
/** Retry-After values at or below this are waited out once for a morechildren batch. */
const MAX_INLINE_WAIT_MS = 3000;
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 3_600_000;
const FALLBACK_RETRY_MS = 60_000;
const MAX_COMMENTS = 5000;
const MAX_BODY_CHARS = 8_000_000;
const MAX_MEDIA_PER_ITEM = 50;
/** Largest response body read before parsing. */
const MAX_RESPONSE_CHARS = 16_000_000;
/** Stop expanding after this long so a partial document still beats the gate's 60 s timeout. */
const DEFAULT_DEADLINE_MS = 45_000;
const HARD_END_MS = 55_000;

const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 4;
/** Cap on cached characters across entries (length loop, no TextEncoder copy). */
const CACHE_MAX_CHARS = 3_000_000;

/* ------------------------------------------------------------------ helpers */

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const ID = /^[a-z0-9]+$/i;

export { redditTarget };

/** Retry-After (seconds or HTTP date) as epoch ms, bounded to [1 s, 1 h], 60 s when unusable. */
export function retryTime(value: string | null, now = Date.now()): number {
  const text = value?.trim() ?? "";
  let ms = FALLBACK_RETRY_MS;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else {
    const date = Date.parse(text);
    if (Number.isFinite(date) && date > now) ms = date - now;
  }
  return now + Math.min(Math.max(ms, MIN_RETRY_MS), MAX_RETRY_MS);
}

function cleanUrl(value: unknown, base: string): string | undefined {
  const text = str(value);
  if (!text?.trim()) return undefined;
  try {
    const url = new URL(text.replace(/&amp;/g, "&"), base);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

const fullId = (value: string, kind: string): string =>
  value.startsWith(`${kind}_`) ? value : `${kind}_${value}`;

const isoDate = (seconds: number | undefined): string | undefined =>
  seconds !== undefined && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : undefined;

/* ------------------------------------------------------------- trimmed model */

interface RMedia {
  kind: "image" | "video" | "embed" | "link";
  url: string;
  caption?: string;
}

interface RComment {
  kind: "t1";
  id: string;
  parentId: string;
  author?: string;
  score?: number;
  created?: number;
  edited?: number;
  op?: boolean;
  distinguished?: string;
  body: string;
  media: RMedia[];
  replies: RItem[];
}

interface RMore {
  kind: "more";
  parentId: string;
  children: string[];
}

type RItem = RComment | RMore;

interface RPostBase {
  id: string;
  title: string;
  author?: string;
  subreddit?: string;
  permalink?: string;
  text: string;
  media: RMedia[];
}

interface RPost extends RPostBase {
  score?: number;
  created?: number;
  edited?: number;
  numComments?: number;
  source?: RPostBase;
}

interface RThread {
  post: RPost;
  items: RItem[];
}

const hiddenScore = (d: Rec): boolean =>
  d["score_hidden"] === true || d["hide_score"] === true;

function mediaOf(d: Rec, base: string, isCrosspostSource = false): RMedia[] {
  const out: RMedia[] = [];
  const seen = new Set<string>();
  const add = (kind: RMedia["kind"], value: unknown, caption?: string) => {
    const url = cleanUrl(value, base);
    if (!url || seen.has(url) || out.length >= MAX_MEDIA_PER_ITEM) return;
    seen.add(url);
    out.push({ kind, url, ...(caption ? { caption } : {}) });
  };
  const meta = isRec(d["media_metadata"]) ? d["media_metadata"] : {};
  const gallery = isRec(d["gallery_data"])
    ? arr(d["gallery_data"]["items"]).filter(isRec)
    : null;
  const keys = gallery
    ? gallery.map((i) => str(i["media_id"]) ?? "")
    : Object.keys(meta);
  for (const key of keys) {
    const entry = meta[key];
    if (!isRec(entry) || entry["status"] === "failed") continue;
    const s = isRec(entry["s"]) ? entry["s"] : {};
    const caption = gallery?.find((i) => i["media_id"] === key)?.["caption"];
    const cap = str(caption);
    if (str(s["mp4"])) add("video", s["mp4"], cap);
    else add("image", s["u"] ?? s["gif"], cap);
  }
  const video = [d["secure_media"], d["media"]]
    .map((m) =>
      isRec(m) && isRec(m["reddit_video"]) ? m["reddit_video"] : null,
    )
    .find(Boolean) as Rec | null | undefined;
  const preview =
    isRec(d["preview"]) && isRec(d["preview"]["reddit_video_preview"])
      ? d["preview"]["reddit_video_preview"]
      : null;
  const v = video ?? preview;
  if (v) add("video", v["fallback_url"] ?? v["hls_url"] ?? v["dash_url"]);
  const dest = str(d["url_overridden_by_dest"]) ?? str(d["url"]);
  if (dest && !d["is_self"] && !d["is_gallery"] && !v) {
    const oembed = [d["secure_media"], d["media"]]
      .map((m) => (isRec(m) && isRec(m["oembed"]) ? m["oembed"] : null))
      .find(Boolean) as Rec | null | undefined;
    if (
      /\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(dest) ||
      d["post_hint"] === "image"
    )
      add("image", dest);
    else if (/\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(dest)) add("video", dest);
    else if (oembed) add("embed", dest, str(oembed["title"]));
    else if (!/reddit\.com\/(?:r\/[^/]+\/)?comments\//.test(dest))
      add("link", dest);
  }
  if (!isCrosspostSource) {
    for (const parent of arr(d["crosspost_parent_list"]).filter(isRec)) {
      for (const m of mediaOf(parent, base, true))
        add(m.kind, m.url, m.caption);
    }
  }
  return out;
}

function trimPostBase(d: Rec, base: string, source: boolean): RPostBase {
  const author = str(d["author"]);
  const subreddit = str(d["subreddit"]);
  const permalink = str(d["permalink"]);
  return {
    id: str(d["id"]) ?? "",
    title: str(d["title"]) ?? "",
    ...(author ? { author } : {}),
    ...(subreddit ? { subreddit } : {}),
    ...(permalink ? { permalink } : {}),
    text: str(d["selftext"]) ?? "",
    media: mediaOf(d, base, source),
  };
}

function trimPost(d: Rec, base: string): RPost {
  const score = hiddenScore(d) ? undefined : num(d["score"]);
  const created = num(d["created_utc"]);
  const edited = num(d["edited"]);
  const numComments = num(d["num_comments"]);
  const source = arr(d["crosspost_parent_list"]).filter(isRec)[0];
  return {
    ...trimPostBase(d, base, false),
    ...(score !== undefined ? { score } : {}),
    ...(created !== undefined ? { created } : {}),
    ...(edited ? { edited } : {}),
    ...(numComments !== undefined ? { numComments } : {}),
    ...(source ? { source: trimPostBase(source, base, true) } : {}),
  };
}

/** Iterative so a hostile 10k-deep reply chain cannot blow the stack. */
function trimItems(listing: unknown[], base: string): RItem[] {
  const root: RItem[] = [];
  const stack: Array<{ raw: unknown[]; out: RItem[] }> = [
    { raw: listing, out: root },
  ];
  while (stack.length) {
    const frame = stack.pop();
    if (!frame) break;
    for (const thing of frame.raw) {
      if (!isRec(thing) || !isRec(thing["data"])) continue;
      const d = thing["data"];
      if (thing["kind"] === "more") {
        frame.out.push({
          kind: "more",
          parentId: str(d["parent_id"]) ?? "",
          children: arr(d["children"]).filter(
            (c): c is string => typeof c === "string" && ID.test(c),
          ),
        });
      } else if (thing["kind"] === "t1" && ID.test(str(d["id"]) ?? "")) {
        const author = str(d["author"]);
        const score = hiddenScore(d) ? undefined : num(d["score"]);
        const created = num(d["created_utc"]);
        const edited = num(d["edited"]);
        const dist = str(d["distinguished"]);
        const comment: RComment = {
          kind: "t1",
          id: str(d["id"]) as string,
          parentId: str(d["parent_id"]) ?? "",
          ...(author ? { author } : {}),
          ...(score !== undefined ? { score } : {}),
          ...(created !== undefined ? { created } : {}),
          ...(edited ? { edited } : {}),
          ...(d["is_submitter"] === true ? { op: true } : {}),
          ...(dist ? { distinguished: dist } : {}),
          body: str(d["body"]) ?? "",
          media: mediaOf(d, base),
          replies: [],
        };
        frame.out.push(comment);
        const replies =
          isRec(d["replies"]) && isRec(d["replies"]["data"])
            ? arr(d["replies"]["data"]["children"])
            : [];
        if (replies.length) stack.push({ raw: replies, out: comment.replies });
      }
    }
  }
  return root;
}

function trimThread(payload: unknown, base: string): RThread {
  const first = Array.isArray(payload) ? payload[0] : undefined;
  const second = Array.isArray(payload) ? payload[1] : undefined;
  const postThing =
    isRec(first) && isRec(first["data"])
      ? arr(first["data"]["children"])
          .filter(isRec)
          .find((t) => t["kind"] === "t3")
      : undefined;
  const postData =
    postThing && isRec(postThing["data"]) ? postThing["data"] : undefined;
  const listing =
    isRec(second) && isRec(second["data"]) ? second["data"]["children"] : null;
  if (!postData || !str(postData["id"]) || !Array.isArray(listing))
    throw new NotThisLayoutError(
      "Reddit did not return a post and comment listing.",
    );
  return { post: trimPost(postData, base), items: trimItems(listing, base) };
}

/* -------------------------------------------------------------------- cache */

interface CacheEntry {
  key: string;
  json: string;
  at: number;
}

/** Holds only trimmed JSON, capped by entry count and total length. */
export class ThreadCache {
  private entries: CacheEntry[] = [];
  constructor(
    private readonly maxEntries = CACHE_MAX_ENTRIES,
    private readonly maxChars = CACHE_MAX_CHARS,
    private readonly ttlMs = CACHE_TTL_MS,
  ) {}

  get(key: string, now = Date.now()): string | null {
    this.entries = this.entries.filter((e) => now - e.at < this.ttlMs);
    return this.entries.find((e) => e.key === key)?.json ?? null;
  }

  set(key: string, json: string, now = Date.now()): boolean {
    this.entries = this.entries.filter((e) => e.key !== key);
    if (json.length > this.maxChars) return false;
    this.entries.push({ key, json, at: now });
    let total = 0;
    for (const e of this.entries) total += e.json.length;
    while (
      this.entries.length > this.maxEntries ||
      (total > this.maxChars && this.entries.length > 1)
    ) {
      const dropped = this.entries.shift();
      total -= dropped?.json.length ?? 0;
    }
    return true;
  }

  get size(): number {
    return this.entries.length;
  }

  get chars(): number {
    let total = 0;
    for (const e of this.entries) total += e.json.length;
    return total;
  }

  clear(): void {
    this.entries = [];
  }
}

/* --------------------------------------------------------------- fetch layer */

export type FetchFn = (input: URL, init: RequestInit) => Promise<Response>;

export interface RedditDeps {
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cache?: ThreadCache;
  /** Pause between morechildren requests. Default 1000 ms. */
  moreSpacingMs?: number;
  /** Stop expanding this long after capture start. Default 45000 ms. */
  deadlineMs?: number;
}

/** Body text, refusing to buffer more than MAX_RESPONSE_CHARS. */
async function readCapped(response: Response): Promise<string> {
  const tooLarge = () =>
    new AdapterError("too_large", "Reddit response is too large.");
  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_RESPONSE_CHARS) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
  }
  return text + decoder.decode();
}

class Http {
  constructor(
    private readonly deps: Required<
      Omit<RedditDeps, "cache" | "moreSpacingMs" | "deadlineMs">
    >,
    private readonly ctx: CaptureContext,
  ) {}

  /** JSON body of a same-origin GET. Throws RateLimitedError on 429, AdapterError otherwise. */
  async json(target: URL, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
    const { signal } = this.ctx;
    if (signal?.aborted) throw new CaptureAbortedError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.deps.fetchFn(target, {
          credentials: "same-origin",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (signal?.aborted) throw new CaptureAbortedError();
        if ((error as { name?: string } | null)?.name === "AbortError")
          throw new AdapterError(
            "timeout",
            `Reddit did not respond within ${Math.ceil(timeoutMs / 1000)} seconds.`,
          );
        throw new AdapterError(
          "network",
          "Network error while contacting Reddit.",
        );
      }
      if (response.status === 429)
        throw new RateLimitedError(
          retryTime(response.headers.get("Retry-After"), this.deps.now()),
          "Reddit rate limit.",
        );
      if (!response.ok)
        throw new AdapterError(
          "http_error",
          `Reddit returned HTTP ${response.status}.`,
        );
      const declared = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS)
        throw new AdapterError("too_large", "Reddit response is too large.");
      let text: string;
      try {
        text = await readCapped(response);
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        if (signal?.aborted) throw new CaptureAbortedError();
        throw new AdapterError(
          "network",
          "Network error while reading the Reddit response.",
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new AdapterError(
          "bad_response",
          "Reddit returned HTML or another non-JSON response.",
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function threadUrl(origin: string, id: string, sort: string): URL {
  const url = new URL(`/comments/${id}.json`, origin);
  url.searchParams.set("raw_json", "1");
  url.searchParams.set("sort", sort);
  url.searchParams.set("limit", "500");
  return url;
}

function moreUrl(
  origin: string,
  id: string,
  sort: string,
  children: string[],
): URL {
  const url = new URL("/api/morechildren.json", origin);
  url.searchParams.set("raw_json", "1");
  url.searchParams.set("sort", sort);
  url.searchParams.set("api_type", "json");
  url.searchParams.set("link_id", `t3_${id}`);
  url.searchParams.set("children", children.join(","));
  return url;
}

/* ------------------------------------------------------------------- state */

class ThreadState {
  readonly comments = new Map<string, RComment>();
  readonly order: string[] = [];
  readonly pending = new Set<string>();
  readonly missing = new Set<string>();
  unresolved = 0;
  bodyChars = 0;
  capped = false;

  ingest(items: RItem[]): void {
    const stack: RItem[] = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item) stack.push(item);
    }
    while (stack.length) {
      const item = stack.pop();
      if (!item) break;
      if (item.kind === "more") {
        if (!item.children.length) this.unresolved++;
        for (const id of item.children)
          if (!this.comments.has(id) && !this.missing.has(id))
            this.pending.add(id);
        continue;
      }
      if (this.comments.has(item.id)) continue;
      if (
        this.comments.size >= MAX_COMMENTS ||
        this.bodyChars > MAX_BODY_CHARS
      ) {
        this.capped = true;
        continue;
      }
      this.bodyChars += item.body.length;
      this.comments.set(item.id, item);
      this.order.push(item.id);
      this.pending.delete(item.id);
      this.missing.delete(item.id);
      for (let i = item.replies.length - 1; i >= 0; i--) {
        const reply = item.replies[i];
        if (reply) stack.push(reply);
      }
    }
    for (const id of this.comments.keys()) this.pending.delete(id);
  }
}

/* --------------------------------------------------------------- conversion */

const mdUrl = (url: string): string =>
  url.replace(/[()\s<>]/g, (c) => encodeURIComponent(c));
const mdLabel = (text: string): string =>
  text
    .replace(/[[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function mediaMarkdown(media: RMedia[]): string {
  return media
    .map((m) => {
      const label = mdLabel(m.caption ?? "") || m.kind;
      return m.kind === "image"
        ? `![${label}](${mdUrl(m.url)})`
        : `[${label}](${mdUrl(m.url)})`;
    })
    .join("\n");
}

/** Drops lines that only repeat an image's URL (bare or as `[url](url)`): the image already carries it. */
function dropImageUrlLines(text: string, media: RMedia[]): string {
  const urls = new Set(
    media.filter((m) => m.kind === "image").map((m) => m.url),
  );
  if (!urls.size) return text;
  const same = (u: string) => {
    const plain = u.replace(/&amp;/g, "&");
    return urls.has(plain) || urls.has(mdUrl(plain));
  };
  const lines = text.split("\n");
  const { mask } = scanCode(lines);
  return lines
    .filter((line, i) => {
      if (mask[i]) return true;
      const t = line.trim();
      const bare = /^<?(https?:\/\/[^\s<>]+)>?$/.exec(t)?.[1];
      if (bare !== undefined) return !same(bare);
      const linked = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(t);
      return !(linked?.[1] && linked[2] && same(linked[1]) && same(linked[2]));
    })
    .join("\n");
}

function bodyWith(text: string, media: RMedia[]): string | undefined {
  let body = normalizeBody(dropImageUrlLines(text, media));
  const closing = unclosedFence(body);
  if (closing !== null && media.length) body += `\n${closing}`;
  const parts = [body, mediaMarkdown(media)].filter(Boolean);
  return parts.length ? normalizeBody(parts.join("\n\n")) : undefined;
}

function buildBlocks(
  thread: RThread,
  state: ThreadState,
  postId: string,
): ThreadBlock[] {
  const { post } = thread;
  const blocks: ThreadBlock[] = [];
  const postBody = bodyWith(post.text, post.media);
  const postDate = isoDate(post.created);
  blocks.push({
    type: "post",
    id: postId,
    parent_id: null,
    ...(post.title ? { title: post.title } : {}),
    author: post.author ?? "[deleted]",
    ...(post.score !== undefined ? { score: post.score } : {}),
    ...(postDate ? { date: postDate } : {}),
    depth: 0,
    ...(postBody ? { body: postBody } : {}),
  });
  if (post.source?.id) {
    const body = bodyWith(post.source.text, []);
    blocks.push({
      type: "post",
      id: fullId(post.source.id, "t3"),
      parent_id: postId,
      ...(post.source.title ? { title: post.source.title } : {}),
      author: post.source.author ?? "[deleted]",
      depth: 0,
      ...(body ? { body } : {}),
    });
  }
  // Replies are nested by parent_id; arrival order is kept among siblings.
  const children = new Map<string, string[]>();
  for (const id of state.order) {
    const c = state.comments.get(id);
    if (!c) continue;
    const parent = c.parentId ? c.parentId : postId;
    const list = children.get(parent);
    if (list) list.push(id);
    else children.set(parent, [id]);
  }
  const emitted = new Set<string>();
  const emit = (id: string, depth: number) => {
    const c = state.comments.get(id);
    if (!c || emitted.has(id)) return undefined;
    emitted.add(id);
    const date = isoDate(c.created);
    const body = bodyWith(c.body, c.media);
    const cid = fullId(c.id, "t1");
    blocks.push({
      type: "comment",
      id: cid,
      parent_id: c.parentId || postId,
      author: c.author ?? "[deleted]",
      ...(c.score !== undefined ? { score: c.score } : {}),
      ...(date ? { date } : {}),
      depth,
      ...(body ? { body } : {}),
    });
    return cid;
  };
  // Iterative DFS (reply chains can be thousands deep).
  const stack: Array<{ id: string; depth: number }> = [];
  const push = (parent: string, depth: number) => {
    const list = children.get(parent) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i];
      if (id) stack.push({ id, depth });
    }
  };
  push(postId, 0);
  while (stack.length) {
    const next = stack.pop();
    if (!next) break;
    if (emit(next.id, next.depth)) push(fullId(next.id, "t1"), next.depth + 1);
  }
  // Comments whose parent was never loaded still count; keep them, flagged by their parent_id.
  for (const id of state.order) {
    if (emitted.has(id)) continue;
    if (emit(id, 0)) push(fullId(id, "t1"), 1);
    while (stack.length) {
      const next = stack.pop();
      if (!next) break;
      if (emit(next.id, next.depth))
        push(fullId(next.id, "t1"), next.depth + 1);
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ capture */

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRedditAdapter(deps: RedditDeps = {}): Adapter {
  const fetchFn: FetchFn =
    deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = deps.sleep ?? sleepDefault;
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? new ThreadCache();
  const spacing = deps.moreSpacingMs ?? MORE_SPACING_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;

  async function capture(ctx: CaptureContext): Promise<ExportDocument> {
    const target = redditTarget(ctx.url);
    if (!target) throw new NotThisLayoutError("This is not a Reddit thread.");
    const sort: RedditSort = SORTS.has(ctx.options.redditSort ?? "")
      ? (ctx.options.redditSort as RedditSort)
      : "confidence";
    const maxMore = Math.min(
      Math.max(0, Math.floor(ctx.options.redditMore ?? DEFAULT_MORE_REQUESTS)),
      MAX_MORE_REQUESTS,
    );
    const http = new Http({ fetchFn, sleep, now }, ctx);
    const key = `${target.origin}|${target.id}|${sort}`;
    const warnings: string[] = [];
    const startedAt = now();
    let retryAt: number | undefined;

    // One cache entry per thread: the trimmed thread plus each morechildren batch result.
    let thread: RThread | undefined;
    let moreCache: Record<string, RItem[]> = {};
    const hit = ctx.options.fresh ? null : cache.get(key, now());
    if (hit) {
      try {
        const parsed = JSON.parse(hit) as {
          thread?: RThread;
          more?: Record<string, RItem[]>;
        };
        thread = parsed.thread;
        moreCache = isRec(parsed.more) ? parsed.more : {};
      } catch {
        thread = undefined;
      }
    }
    const cached = thread !== undefined;
    let dirty = false;
    const persist = () => {
      if (!thread) return;
      if (!cache.set(key, JSON.stringify({ thread, more: moreCache }), now()))
        cache.set(key, JSON.stringify({ thread, more: {} }), now());
    };
    if (!thread) {
      const payload = await http.json(
        threadUrl(target.origin, target.id, sort),
      );
      thread = trimThread(payload, target.origin);
      persist();
    }

    const state = new ThreadState();
    state.bodyChars =
      thread.post.text.length + (thread.post.source?.text.length ?? 0);
    state.ingest(thread.items);

    let requests = 0;
    let fetched = 0;
    while (state.pending.size && requests < maxMore && !state.capped) {
      const batch = [...state.pending].slice(0, MORE_BATCH);
      const batchKey = batch.join(",");
      const cachedItems = moreCache[batchKey];
      if (!cachedItems) {
        if (fetched > 0 && spacing > 0) await sleep(spacing);
        if (now() - startedAt >= deadlineMs) {
          warnings.push(
            "Stopped loading additional comments at the time limit; the thread is partial.",
          );
          break;
        }
      }
      if (ctx.signal?.aborted) throw new CaptureAbortedError();
      requests++;
      try {
        let items = cachedItems;
        if (!items) {
          fetched++;
          const url = moreUrl(target.origin, target.id, sort, batch);
          const timeout = Math.min(
            FETCH_TIMEOUT_MS,
            Math.max(1000, startedAt + HARD_END_MS - now()),
          );
          let things: unknown;
          try {
            things = await http.json(url, timeout);
          } catch (error) {
            if (
              error instanceof RateLimitedError &&
              error.retryAt - now() <= MAX_INLINE_WAIT_MS
            ) {
              await sleep(Math.max(0, error.retryAt - now()));
              things = await http.json(url, timeout);
            } else throw error;
          }
          const json =
            isRec(things) && isRec(things["json"]) ? things["json"] : {};
          const errors = arr(json["errors"]);
          const list =
            isRec(json["data"]) && Array.isArray(json["data"]["things"])
              ? (json["data"]["things"] as unknown[])
              : null;
          if (errors.length || !list) {
            warnings.push(
              "Reddit rejected a request for additional comments; the thread is partial.",
            );
            break;
          }
          items = trimItems(list, target.origin);
          moreCache[batchKey] = items;
          dirty = true;
        }
        state.ingest(items);
        for (const id of batch) {
          state.pending.delete(id);
          if (!state.comments.has(id)) state.missing.add(id);
        }
      } catch (error) {
        if (error instanceof CaptureAbortedError) throw error;
        if (error instanceof RateLimitedError) retryAt = error.retryAt;
        const wait =
          error instanceof RateLimitedError
            ? ` Reddit asked to retry after ${new Date(error.retryAt).toISOString()}.`
            : "";
        warnings.push(
          `Loading additional comments stopped early (${
            error instanceof AdapterError ? error.code : "error"
          }); the thread is partial.${wait}`,
        );
        break;
      }
    }

    if (dirty) persist();

    if (state.capped)
      warnings.push(
        `Stopped at the ${MAX_COMMENTS} comment / ${MAX_BODY_CHARS} character limit; the thread is partial.`,
      );
    if (state.unresolved)
      warnings.push(
        `${state.unresolved} "continue this thread" link(s) were not expanded.`,
      );
    if (state.pending.size)
      warnings.push(
        `${state.pending.size} comment id(s) were not loaded (expansion limit of ${maxMore} request(s)).`,
      );
    if (state.missing.size)
      warnings.push(
        `${state.missing.size} requested comment(s) were unavailable.`,
      );

    const reported = thread.post.numComments;
    const captured = state.comments.size;
    let removed = 0;
    for (const c of state.comments.values())
      if (c.body === "[deleted]" || c.body === "[removed]") removed++;
    const partial =
      state.pending.size > 0 ||
      state.unresolved > 0 ||
      state.missing.size > 0 ||
      state.capped ||
      warnings.length > 0;
    if (reported !== undefined && reported > captured)
      warnings.unshift(
        `Captured ${captured} of ${reported} reported comments.`,
      );

    const postId = fullId(thread.post.id, "t3");
    const canonical = cleanUrl(thread.post.permalink, target.origin);
    const coverage: Coverage = {
      comments_reported: reported ?? null,
      comments_captured: captured,
      comments_deleted_or_removed: removed,
      pending_comment_ids: state.pending.size,
      unresolved_more_nodes: state.unresolved,
      requested_comments_unavailable: state.missing.size,
      more_requests: requests,
      cached,
      sort,
      partial,
      ...(retryAt !== undefined ? { retry_at: retryAt } : {}),
    };
    const meta: Meta = {
      url: ctx.url,
      ...(canonical ? { canonical } : {}),
      title: thread.post.title || "Reddit thread",
      captured_at: new Date(now()).toISOString(),
      adapter: "reddit",
      scope: "thread",
      site: thread.post.subreddit
        ? `Reddit r/${thread.post.subreddit}`
        : "Reddit",
      coverage,
      content_trust: "untrusted",
    };
    if (warnings.length) meta.warnings = warnings;
    return { meta, blocks: buildBlocks(thread, state, postId) };
  }

  return {
    id: "reddit",
    matches: (url) => redditTarget(url) !== null,
    capture,
  };
}

export const redditAdapter: Adapter = createRedditAdapter();
