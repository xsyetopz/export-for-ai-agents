/**
 * Generic adapter (design D6, D7, D8): main-content DOM extraction in one TreeWalker pass per
 * subtree (text, links and media gathered together), plus schema.org JSON-LD metadata.
 * Page content is untrusted: nothing is evaluated, inserted as HTML, or fetched, and sizes are capped.
 */

import type {
  ContentBlock,
  ExportDocument,
  ItemBlock,
  LinkBlock,
  MediaBlock,
  Meta,
} from "../model.ts";
import { type JsonLdMeta, parseJsonLd } from "./jsonld.ts";
import {
  type Adapter,
  CaptureAbortedError,
  type CaptureContext,
  EmptySelectionError,
} from "./types.ts";

const DEFAULT_MAX_NODES = 100_000;
const DEFAULT_MAX_BLOCKS = 20_000;
const DEFAULT_SLICE_MS = 8;
const MAX_SPAN = 50;
const MAX_RUN_CHARS = 200_000;
const MAX_CODE_CHARS = 500_000;
const MAX_TOTAL_CHARS = 8_000_000;
const MAX_SELECTION_CHARS = 1_000_000;
const MAX_FIELD_CHARS = 2000;
const SHOW_ELEMENT_AND_TEXT = 0x1 | 0x4;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "link",
  "meta",
  "title",
  "base",
  "input",
  "textarea",
  "select",
  "option",
  "optgroup",
  "datalist",
  "object",
  "embed",
  "param",
  "source",
  "track",
  "area",
  "map",
]);

/** Containers: flush the pending inline run on entry and exit, then descend in the same walk. */
const CONTAINER_TAGS = new Set([
  "div",
  "section",
  "article",
  "main",
  "nav",
  "aside",
  "header",
  "footer",
  "figure",
  "form",
  "fieldset",
  "address",
  "hgroup",
  "body",
  "html",
  "dl",
  "li",
  "summary",
  "center",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "legend",
]);

/** Inside inline runs these break words so adjacent blocks do not glue together. */
const BREAKING_TAGS = new Set([
  ...CONTAINER_TAGS,
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "menu",
  "pre",
  "table",
  "blockquote",
  "dt",
  "dd",
  "figcaption",
  "details",
  "hr",
]);

const BOUNDARY_ROLES = new Set([
  "navigation",
  "complementary",
  "banner",
  "contentinfo",
]);

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const MEDIA_PROTOCOLS = new Set(["http:", "https:"]);

function clampInt(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), max)
    : fallback;
}

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

const tagOf = (el: Element): string => el.localName.toLowerCase();

interface OpenLink {
  el: Element;
  href: string;
  start: number;
  extra: string;
}

/** Pending inline content: text plus the links and media found while gathering it. */
interface Run {
  text: string;
  extras: ContentBlock[];
  seen: Set<string>;
  open: OpenLink[];
}

interface Frame {
  out: ContentBlock[];
  run: Run;
  term: string | undefined;
}

const newRun = (): Run => ({
  text: "",
  extras: [],
  seen: new Set(),
  open: [],
});
const newFrame = (): Frame => ({ out: [], run: newRun(), term: undefined });

/**
 * Move to the next node of a TreeWalker rooted at `root`, calling `onExit` for every element whose
 * subtree has just been finished (TreeWalker has no exit events). `skip` skips the current subtree.
 */
function advance(
  tw: TreeWalker,
  root: Node,
  skip: boolean,
  onExit: (el: Element) => void,
): Node | null {
  if (!skip) {
    const child = tw.firstChild();
    if (child) return child;
    if (tw.currentNode !== root && tw.currentNode.nodeType === 1)
      onExit(tw.currentNode as Element);
  }
  for (;;) {
    if (tw.currentNode === root) return null;
    const sibling = tw.nextSibling();
    if (sibling) return sibling;
    const parent = tw.parentNode();
    if (!parent) return null;
    if (parent !== root) onExit(parent as Element);
  }
}

function hostOf(node: Node): Element | null {
  const root = node.getRootNode() as Partial<ShadowRoot>;
  return root.host ?? null;
}

/** `closest()` that continues through shadow roots by walking the host chain. */
export function closestAcrossShadow(
  el: Element,
  selector: string,
): Element | null {
  let current: Element | null = el;
  while (current) {
    const hit = current.closest(selector);
    if (hit) return hit;
    current = hostOf(current);
  }
  return null;
}

function defaultYield(): Promise<void> {
  const scheduler = (
    globalThis as { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class Capture {
  readonly ctx: CaptureContext;
  readonly doc: Document;
  readonly maxNodes: number;
  readonly maxBlocks: number;
  readonly sliceMs: number;
  readonly now: () => number;
  readonly warnings = new Set<string>();
  readonly seenMedia = new Set<string>();
  readonly base: string;
  readonly boundaries: boolean;
  nodes = 0;
  blocks = 0;
  chars = 0;
  limited = false;
  /** Something was dropped or truncated, but the walk continued. */
  truncated = false;
  sliceStart: number;
  /** Selector for subtrees an adapter wants left out (e.g. a reply link inside a comment body). */
  exclude: string | undefined;

  constructor(ctx: CaptureContext) {
    this.ctx = ctx;
    this.doc = ctx.document;
    this.maxNodes = clampInt(
      ctx.options.maxNodes,
      DEFAULT_MAX_NODES,
      1_000_000,
    );
    this.maxBlocks = clampInt(
      ctx.options.maxBlocks,
      DEFAULT_MAX_BLOCKS,
      100_000,
    );
    this.sliceMs = clampInt(ctx.options.sliceMs, DEFAULT_SLICE_MS, 1000);
    this.now = ctx.now ?? (() => performance.now());
    this.sliceStart = this.now();
    this.boundaries = ctx.options.scope !== "page";
    this.base = this.resolveBase();
  }

  private resolveBase(): string {
    const candidate = this.doc.baseURI;
    return candidate && /^https?:/i.test(candidate) ? candidate : this.ctx.url;
  }

  // ---- control: abort, limits, time slicing ----

  checkAbort(): void {
    if (this.ctx.signal?.aborted) throw new CaptureAbortedError();
  }

  /** Count one visited node. False once a limit is hit. */
  tick(): boolean {
    if (this.limited) return false;
    if (++this.nodes > this.maxNodes) {
      this.limited = true;
      return false;
    }
    if ((this.nodes & 127) === 0) this.checkAbort();
    return true;
  }

  async maybeYield(): Promise<void> {
    this.checkAbort();
    if (this.now() - this.sliceStart < this.sliceMs) return;
    await (this.ctx.yieldFn ?? defaultYield)();
    this.checkAbort();
    this.sliceStart = this.now();
  }

  /** Count one block against the cap. False (and limited) when the cap is reached. */
  reserve(): boolean {
    if (this.blocks >= this.maxBlocks) {
      this.limited = true;
      return false;
    }
    this.blocks++;
    return true;
  }

  /** An oversized block is dropped alone; later, smaller blocks still fit. */
  fits(size: number): boolean {
    if (this.chars + size > MAX_TOTAL_CHARS) {
      this.truncated = true;
      return false;
    }
    this.chars += size;
    return true;
  }

  /**
   * Emit a block. `container` blocks (list, table, quote) hold children that were already
   * counted, so they bypass the block cap and are never dropped with their content.
   */
  emit(
    out: ContentBlock[],
    block: ContentBlock,
    size = 0,
    container = false,
  ): void {
    if (!this.fits(size)) return;
    if (!container && !this.reserve()) return;
    out.push(block);
  }

  // ---- helpers ----

  url(value: string | null | undefined, allowed: Set<string>): string | null {
    if (!value) return null;
    try {
      const parsed = new URL(value.trim(), this.base);
      return allowed.has(parsed.protocol) ? parsed.href : null;
    } catch {
      return null;
    }
  }

  isHidden(el: Element, tag: string): boolean {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true")
      return true;
    if (tag === "slot") return false;
    if (typeof el.checkVisibility === "function") {
      if (
        el.checkVisibility({
          checkVisibilityCSS: true,
          visibilityProperty: true,
        })
      )
        return false;
      // display: contents has no box, so checkVisibility reports false although children render.
      const view = el.ownerDocument.defaultView;
      return view?.getComputedStyle(el).display !== "contents";
    }
    const style = (el as HTMLElement).style;
    return style?.display === "none" || style?.visibility === "hidden";
  }

  /** False for elements whose subtree is not content (skipped tags, hidden, editable). */
  accepts(el: Element, tag: string): boolean {
    if (SKIP_TAGS.has(tag)) return false;
    if ((el as HTMLElement).isContentEditable === true) return false;
    if (this.exclude && el.matches(this.exclude)) return false;
    return !this.isHidden(el, tag);
  }

  /** nav/aside/landmark chrome, outside the content when scope is not "page". */
  isBoundary(el: Element, tag: string, role: string | null): boolean {
    if (tag === "nav" || tag === "aside") return true;
    if (role && BOUNDARY_ROLES.has(role)) return true;
    if (tag === "header" || tag === "footer")
      return !closestAcrossShadow(el, 'article,main,[role="main"]');
    return false;
  }

  walker(root: Node): TreeWalker {
    const owner = root.ownerDocument ?? this.doc;
    return owner.createTreeWalker(root, SHOW_ELEMENT_AND_TEXT);
  }

  appendText(run: Run, text: string): void {
    const room = MAX_RUN_CHARS - run.text.length;
    if (room <= 0) {
      this.truncated = true;
    } else {
      if (text.length > room) this.truncated = true;
      run.text += text.length > room ? text.slice(0, room) : text;
    }
  }

  // ---- inline gathering (one pass: text, links, media) ----

  /** Handles one node of an inline run. Returns true when its children should be walked. */
  visitInline(el: Element, tag: string, run: Run): boolean {
    const role = el.getAttribute("role");
    if (tag === "br") {
      run.text += " ";
      return false;
    }
    if (tag === "a") {
      const href = this.linkUrl(el.getAttribute("href"));
      if (href) run.open.push({ el, href, start: run.text.length, extra: "" });
      return true;
    }
    if (tag === "img") {
      this.image(el, run);
      return false;
    }
    if (tag === "video" || tag === "audio") {
      this.av(el, tag, run);
      return false;
    }
    if (tag === "iframe") {
      this.frame(el, run);
      return false;
    }
    if (tag === "svg") {
      const label =
        el.getAttribute("aria-label") ??
        el.querySelector("title")?.textContent ??
        "";
      const text = normalize(label).slice(0, MAX_FIELD_CHARS);
      if (text) this.appendText(run, ` [${text}] `);
      return false;
    }
    if (tag === "canvas") {
      this.warnings.add("Canvas pixels were not extracted.");
      return false;
    }
    if (tag === "button" || role === "button") {
      if (this.ctx.options.controls) {
        const label = normalize(
          el.textContent ||
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            "",
        ).slice(0, MAX_FIELD_CHARS);
        if (label)
          this.addExtra(run, { type: "control", kind: "button", label });
      }
      return false;
    }
    if (BREAKING_TAGS.has(tag)) run.text += " ";
    return true;
  }

  exitInline(el: Element, tag: string, run: Run): void {
    if (tag === "a") {
      const top = run.open[run.open.length - 1];
      if (top?.el === el) {
        run.open.pop();
        this.closeLink(run, top);
      }
    } else if (BREAKING_TAGS.has(tag)) {
      run.text += " ";
    }
  }

  closeLink(run: Run, open: OpenLink): void {
    const text =
      normalize(`${run.text.slice(open.start)} ${open.extra}`) ||
      normalize(
        open.el.getAttribute("aria-label") ??
          open.el.getAttribute("title") ??
          "",
      ) ||
      open.href;
    const key = `${open.href}\n${text}`;
    if (run.seen.has(key)) return;
    run.seen.add(key);
    run.extras.push({
      type: "link",
      url: open.href,
      text: text.slice(0, MAX_FIELD_CHARS),
    } satisfies LinkBlock);
  }

  linkUrl(href: string | null): string | null {
    if (!href || href.trimStart().startsWith("#")) return null;
    return this.url(href, LINK_PROTOCOLS);
  }

  addExtra(run: Run, block: ContentBlock): void {
    run.extras.push(block);
  }

  image(el: Element, run: Run): void {
    const src =
      (el as HTMLImageElement).currentSrc ||
      el.getAttribute("src") ||
      el.getAttribute("data-src") ||
      el.getAttribute("data-lazy-src");
    const url = this.url(src, MEDIA_PROTOCOLS);
    if (!url || this.seenMedia.has(url)) return;
    this.seenMedia.add(url);
    const alt = normalize(el.getAttribute("alt") ?? "").slice(
      0,
      MAX_FIELD_CHARS,
    );
    const block: MediaBlock = { type: "media", kind: "image", url };
    if (alt) block.alt = alt;
    run.extras.push(block);
  }

  av(el: Element, tag: string, run: Run): void {
    const src =
      (el as HTMLMediaElement).currentSrc ||
      el.getAttribute("src") ||
      el.querySelector("source[src]")?.getAttribute("src");
    const url = this.url(src, MEDIA_PROTOCOLS);
    if (!url) {
      this.warnings.add(
        "Media without a reusable URL (blob or stream) was skipped.",
      );
      return;
    }
    if (this.seenMedia.has(url)) return;
    this.seenMedia.add(url);
    run.extras.push({
      type: "media",
      kind: tag === "video" ? "video" : "audio",
      url,
    });
  }

  frame(el: Element, run: Run): void {
    this.warnings.add(
      "Embedded frames are recorded as links; their documents are not read.",
    );
    const url = this.url(el.getAttribute("src"), MEDIA_PROTOCOLS);
    if (!url || this.seenMedia.has(url)) return;
    this.seenMedia.add(url);
    const title = normalize(el.getAttribute("title") ?? "").slice(
      0,
      MAX_FIELD_CHARS,
    );
    const block: MediaBlock = { type: "media", kind: "embed", url };
    if (title) block.title = title;
    run.extras.push(block);
  }

  /** Content of a shadow host or slot inside an inline run. */
  inlineChildren(el: Element, tag: string, run: Run): boolean {
    const shadow = el.shadowRoot;
    if (shadow) {
      this.scanInline(shadow, run);
      return true;
    }
    if (tag === "slot") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length) {
        for (const node of assigned) this.inlineStandalone(node, run);
        return true;
      }
    }
    return false;
  }

  inlineStandalone(node: Node, run: Run): void {
    if (node.nodeType === 3) {
      this.appendText(run, (node as Text).data);
      return;
    }
    if (node.nodeType !== 1 || !this.tick()) return;
    const el = node as Element;
    const tag = tagOf(el);
    if (!this.accepts(el, tag)) return;
    if (this.inlineChildren(el, tag, run)) return;
    if (this.visitInline(el, tag, run)) {
      this.scanInline(el, run);
      this.exitInline(el, tag, run);
    }
  }

  /** Walks the descendants of `root` once, appending to `run`. */
  scanInline(root: Node, run: Run): void {
    const tw = this.walker(root);
    const onExit = (el: Element) => this.exitInline(el, tagOf(el), run);
    let node = advance(tw, root, false, onExit);
    while (node) {
      if (!this.tick()) return;
      let descend = false;
      if (node.nodeType === 3) {
        this.appendText(run, (node as Text).data);
      } else {
        const el = node as Element;
        const tag = tagOf(el);
        if (this.accepts(el, tag)) {
          descend = this.inlineChildren(el, tag, run)
            ? false
            : this.visitInline(el, tag, run);
          if (!descend && el.shadowRoot === null && BREAKING_TAGS.has(tag))
            run.text += " ";
        }
      }
      node = advance(tw, root, !descend, onExit);
    }
    // Links left open (limit reached, or exit not seen) still count.
    while (run.open.length) {
      const open = run.open.pop();
      if (open) this.closeLink(run, open);
    }
  }

  gather(el: Element): Run {
    const run = newRun();
    this.scanInline(el, run);
    return run;
  }

  // ---- flow (block structure) ----

  /** Emit pending inline text as a paragraph, then its links and media. */
  flush(frame: Frame): void {
    const run = frame.run;
    const text = normalize(run.text).slice(0, MAX_RUN_CHARS);
    if (text) this.emit(frame.out, { type: "paragraph", text }, text.length);
    for (const extra of run.extras) this.emit(frame.out, extra);
    // A link spanning blocks takes its text from what was flushed inside it.
    for (const open of run.open) {
      this.noteLinkText(open, text);
      open.start = 0;
    }
    run.text = "";
    run.extras = [];
    run.seen.clear();
  }

  noteLinkText(open: OpenLink, text: string): void {
    if (text && open.extra.length < MAX_FIELD_CHARS)
      open.extra = `${open.extra} ${text}`.slice(0, MAX_FIELD_CHARS);
  }

  /** Emit a gathered run as one block (heading, paragraph, definition) plus its extras. */
  emitRun(
    frame: Frame,
    gathered: Run,
    make: (text: string) => ContentBlock | null,
  ): string {
    this.flush(frame);
    const text = normalize(gathered.text).slice(0, MAX_RUN_CHARS);
    if (text) {
      const block = make(text);
      if (block) this.emit(frame.out, block, text.length);
      // An enclosing link (a card wrapping a heading) takes its text from the blocks inside.
      for (const open of frame.run.open) this.noteLinkText(open, text);
    }
    for (const extra of gathered.extras) this.emit(frame.out, extra);
    return text;
  }

  async scanFlow(root: Node, frame: Frame): Promise<void> {
    const tw = this.walker(root);
    const onExit = (el: Element) => this.exitFlow(el, frame);
    let node = advance(tw, root, false, onExit);
    let sinceCheck = 0;
    while (node) {
      if (!this.tick()) break;
      if ((++sinceCheck & 15) === 0) await this.maybeYield();
      let descend = false;
      if (node.nodeType === 3) {
        this.appendText(frame.run, (node as Text).data);
      } else {
        const entered = this.enterFlow(node as Element, frame);
        descend = typeof entered === "boolean" ? entered : await entered;
      }
      node = advance(tw, root, !descend, onExit);
    }
  }

  exitFlow(el: Element, frame: Frame): void {
    const tag = tagOf(el);
    if (tag === "a") {
      this.exitInline(el, tag, frame.run);
    } else if (CONTAINER_TAGS.has(tag) || el.shadowRoot) {
      this.flush(frame);
    }
  }

  /** Standalone node (slot assignment): same handling as a walked node, including its subtree. */
  async flowStandalone(node: Node, frame: Frame): Promise<void> {
    if (node.nodeType === 3) {
      this.appendText(frame.run, (node as Text).data);
      return;
    }
    if (node.nodeType !== 1 || !this.tick()) return;
    const el = node as Element;
    const entered = this.enterFlow(el, frame);
    const descend = typeof entered === "boolean" ? entered : await entered;
    if (descend) {
      await this.scanFlow(el, frame);
      this.exitFlow(el, frame);
    }
  }

  /** Handles an element in flow mode. Resolves true when its children should be walked. */
  enterFlow(el: Element, frame: Frame): boolean | Promise<boolean> {
    const tag = tagOf(el);
    if (!this.accepts(el, tag)) return false;
    const role = el.getAttribute("role");
    if (this.boundaries && this.isBoundary(el, tag, role)) return false;

    if (/^h[1-6]$/.test(tag) || role === "heading") {
      const level = Number(el.getAttribute("aria-level") || tag.slice(1));
      this.emitRun(frame, this.gather(el), (text) => ({
        type: "heading",
        level: (level >= 1 && level <= 6 ? level : 2) as 1 | 2 | 3 | 4 | 5 | 6,
        text,
      }));
      return false;
    }
    if (role === "list" && tag !== "ul" && tag !== "ol" && tag !== "menu")
      return this.list(el, frame, false).then(() => false);
    switch (tag) {
      case "p":
      case "figcaption":
        this.emitRun(frame, this.gather(el), (text) => ({
          type: "paragraph",
          text,
        }));
        return false;
      case "dt":
        frame.term = normalize(this.gather(el).text);
        return false;
      case "dd": {
        const term = frame.term;
        frame.term = undefined;
        this.emitRun(frame, this.gather(el), (text) =>
          term
            ? { type: "definition", term, text }
            : { type: "paragraph", text },
        );
        return false;
      }
      case "pre":
        this.flush(frame);
        this.code(el, frame);
        return false;
      case "ul":
      case "ol":
      case "menu":
        return this.list(el, frame, tag === "ol").then(() => false);
      case "blockquote":
        return this.quote(el, frame).then(() => false);
      case "table":
        return this.tableOrDescend(el, frame);
      case "details":
        return this.details(el, frame);
      case "hr":
        this.flush(frame);
        return false;
    }
    if (el.shadowRoot || tag === "slot") return this.composed(el, tag, frame);
    if (CONTAINER_TAGS.has(tag)) {
      this.flush(frame);
      return true;
    }
    return this.visitInline(el, tag, frame.run);
  }

  async composed(el: Element, tag: string, frame: Frame): Promise<boolean> {
    this.flush(frame);
    if (el.shadowRoot) {
      await this.scanFlow(el.shadowRoot, frame);
      this.flush(frame);
      return false;
    }
    const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
    if (!assigned.length) return true; // fallback content
    for (const node of assigned) await this.flowStandalone(node, frame);
    this.flush(frame);
    return tag !== "slot";
  }

  details(el: Element, frame: Frame): boolean {
    this.flush(frame);
    if ((el as HTMLDetailsElement).open) return true;
    const summary = el.querySelector("summary");
    if (summary) {
      this.emitRun(frame, this.gather(summary), (text) => ({
        type: "paragraph",
        text,
      }));
    }
    this.warnings.add("Closed disclosure content was not extracted.");
    return false;
  }

  code(el: Element, frame: Frame): void {
    // Count and cap the text nodes instead of reading textContent of an unbounded subtree.
    const tw = (el.ownerDocument ?? this.doc).createTreeWalker(el, 0x4);
    let raw = "";
    for (
      let n = tw.nextNode();
      n && raw.length < MAX_CODE_CHARS;
      n = tw.nextNode()
    ) {
      if (!this.tick()) break;
      raw += (n as Text).data;
    }
    if (raw.length > MAX_CODE_CHARS) {
      raw = raw.slice(0, MAX_CODE_CHARS);
      this.truncated = true;
    }
    const text = raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (!text.trim()) return;
    const pattern = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/;
    const language =
      el.querySelector("code")?.className.match(pattern)?.[1] ??
      el.className.match(pattern)?.[1] ??
      el.getAttribute("data-language") ??
      el.getAttribute("data-lang") ??
      undefined;
    const block: ContentBlock = { type: "code", text };
    if (language) block.language = language.slice(0, 64);
    this.emit(frame.out, block, text.length);
  }

  async quote(el: Element, frame: Frame): Promise<void> {
    this.flush(frame);
    const sub = newFrame();
    await this.scanFlow(el, sub);
    this.flush(sub);
    if (sub.out.length) {
      this.emit(frame.out, { type: "quote", blocks: sub.out }, 0, true);
    }
  }

  async list(el: Element, frame: Frame, ordered: boolean): Promise<void> {
    this.flush(frame);
    const items: ItemBlock[] = [];
    for (const child of Array.from(el.children)) {
      if (!this.tick() || this.limited) break;
      const tag = tagOf(child);
      if (!this.accepts(child, tag)) continue;
      const sub = newFrame();
      if (tag === "li" || child.getAttribute("role") === "listitem") {
        await this.scanFlow(child, sub);
      } else {
        // Unexpected child of a list: treat it as one item and walk its subtree too.
        await this.flowStandalone(child, sub);
      }
      this.flush(sub);
      const first = sub.out[0];
      const item: ItemBlock =
        first?.type === "paragraph"
          ? { type: "item", text: first.text }
          : { type: "item", text: "" };
      const rest = first?.type === "paragraph" ? sub.out.slice(1) : sub.out;
      if (rest.length) item.blocks = rest;
      if (!item.text && !item.blocks) continue;
      // The leading paragraph became the item text; it must not count twice.
      if (first?.type === "paragraph") this.blocks--;
      if (!this.reserve()) break;
      items.push(item);
      await this.maybeYield();
    }
    if (!items.length) return;
    const block: ContentBlock = { type: "list", ordered, items };
    const start = ordered
      ? Number.parseInt(el.getAttribute("start") ?? "", 10)
      : NaN;
    if (Number.isInteger(start) && start >= 0 && start !== 1)
      block.start = Math.min(start, 999_999_000);
    if (ordered && el.hasAttribute("reversed"))
      this.warnings.add("Reversed list numbering was not preserved.");
    this.emit(frame.out, block, 0, true);
  }

  async tableOrDescend(el: Element, frame: Frame): Promise<boolean> {
    this.flush(frame);
    const role = el.getAttribute("role");
    const layout =
      role === "presentation" ||
      role === "none" ||
      // A nested table means nesting for layout. Cells holding paragraphs or lists are still
      // data (docs tables), so they are flattened per cell rather than treated as layout.
      el.querySelector("table") !== null;
    if (layout) return true; // layout table: rows and cells become containers
    const table = el as HTMLTableElement;
    const rows: string[][] = [];
    let header: string[] = [];
    const extras = newRun();
    const carry: ({ text: string; left: number } | undefined)[] = [];
    const caption = table.caption;
    if (caption && this.accepts(caption, "caption")) {
      this.emitRun(frame, this.gather(caption), (text) => ({
        type: "paragraph",
        text,
      }));
    }
    for (const row of Array.from(table.rows)) {
      if (!this.tick()) break;
      if (!this.accepts(row, "tr")) continue;
      const cells: string[] = [];
      let allHeader = true;
      const fillCarry = () => {
        for (
          let c = carry[cells.length];
          c && c.left > 0;
          c = carry[cells.length]
        ) {
          cells.push(c.text);
          c.left--;
        }
      };
      for (const cell of Array.from(row.cells)) {
        if (!this.tick()) break;
        const ctag = tagOf(cell);
        if (!this.accepts(cell, ctag)) continue;
        fillCarry();
        if (ctag !== "th") allHeader = false;
        const gathered = this.gather(cell);
        const text = normalize(gathered.text).slice(0, MAX_RUN_CHARS);
        const colSpan = Math.max(
          1,
          Math.min(Number(cell.colSpan) || 1, MAX_SPAN),
        );
        const rowSpan = Math.max(
          1,
          Math.min(Number(cell.rowSpan) || 1, MAX_SPAN),
        );
        for (let k = 0; k < colSpan; k++) {
          if (rowSpan > 1)
            carry[cells.length] = { text: "", left: rowSpan - 1 };
          cells.push(k === 0 ? text : "");
        }
        for (const extra of gathered.extras) extras.extras.push(extra);
      }
      fillCarry();
      if (!cells.length) continue;
      if (!this.reserve()) break;
      if (rows.length === 0 && header.length === 0 && allHeader) header = cells;
      else rows.push(cells);
      await this.maybeYield();
    }
    if (rows.length || header.length)
      this.emit(frame.out, { type: "table", header, rows }, 0, true);
    for (const extra of extras.extras) this.emit(frame.out, extra);
    return false;
  }
}

// ---- document-level capture ----

function metaContent(doc: Document, selector: string): string | undefined {
  const value = doc.querySelector(selector)?.getAttribute("content");
  const text = value ? normalize(value).slice(0, MAX_FIELD_CHARS) : "";
  return text || undefined;
}

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

function pickLanguage(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const tag = value?.trim();
    if (tag && tag.length <= 35 && LANGUAGE_TAG.test(tag)) return tag;
  }
  return undefined;
}

function pageMeta(
  cap: Capture,
  ld: JsonLdMeta,
): Omit<Meta, "scope" | "adapter"> {
  const doc = cap.doc;
  const canonical = cap.url(
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    MEDIA_PROTOCOLS,
  );
  const title =
    normalize(doc.title || "").slice(0, MAX_FIELD_CHARS) ||
    metaContent(doc, 'meta[property="og:title"]') ||
    ld.title ||
    normalize(doc.querySelector("h1")?.textContent ?? "").slice(
      0,
      MAX_FIELD_CHARS,
    ) ||
    cap.ctx.url;
  const meta: Omit<Meta, "scope" | "adapter"> = {
    url: cap.ctx.url,
    title,
    captured_at: new Date().toISOString(),
    content_trust: "untrusted",
  };
  if (canonical) meta.canonical = canonical;
  const description =
    metaContent(doc, 'meta[name="description"]') ??
    metaContent(doc, 'meta[property="og:description"]') ??
    ld.description;
  if (description) meta.description = description;
  const language = pickLanguage(doc.documentElement?.lang, ld.language);
  if (language) meta.language = language;
  const site = metaContent(doc, 'meta[property="og:site_name"]') ?? ld.site;
  if (site) meta.site = site;
  const author = ld.author ?? metaContent(doc, 'meta[name="author"]');
  if (author) meta.author = author;
  const published =
    ld.published ?? metaContent(doc, 'meta[property="article:published_time"]');
  if (published) meta.published = published;
  return meta;
}

function jsonLd(doc: Document): JsonLdMeta {
  const texts: string[] = [];
  for (const script of Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    texts.push(script.textContent ?? "");
  }
  return parseJsonLd(texts);
}

function chooseRoot(cap: Capture, scope: string | undefined): Element {
  const doc = cap.doc;
  const body = doc.body ?? doc.documentElement;
  if (scope === "page") return body;
  const visible = (el: Element) => cap.accepts(el, tagOf(el));
  // textContent is O(subtree); measure each candidate once, not inside a sort comparator.
  let best: Element | null = null;
  let bestLength = -1;
  for (const el of Array.from(doc.querySelectorAll('main,[role="main"]'))) {
    if (!visible(el)) continue;
    const length = el.textContent?.length ?? 0;
    if (length > bestLength) {
      best = el;
      bestLength = length;
    }
  }
  if (best) return best;
  const articles = Array.from(doc.querySelectorAll("article")).filter(visible);
  // A feed of several articles must not collapse to one card.
  return articles.length === 1 && articles[0] ? articles[0] : body;
}

/** Ancestor-or-self of `node` that lives in the tree of `root`, climbing through shadow hosts. */
function ascendTo(node: Node, root: Node): Node | null {
  let current: Node | null = node;
  while (current) {
    if (current.getRootNode() === root) return current;
    current = hostOf(current);
  }
  return null;
}

/**
 * A Range cannot span trees. Same root: one Range. Across a shadow boundary: one Range per side,
 * each running to the edge of the other side's host (content in between is not covered).
 */
function composedToRanges(doc: Document, s: StaticRange): Range[] {
  const startRoot = s.startContainer.getRootNode();
  const endRoot = s.endContainer.getRootNode();
  if (startRoot === endRoot) {
    const range = doc.createRange();
    range.setStart(s.startContainer, s.startOffset);
    range.setEnd(s.endContainer, s.endOffset);
    return [range];
  }
  const first = doc.createRange();
  first.setStart(s.startContainer, s.startOffset);
  const endHost = ascendTo(s.endContainer, startRoot);
  if (endHost) first.setEndAfter(endHost);
  else first.setEnd(startRoot, startRoot.childNodes.length);
  const second = doc.createRange();
  second.setEnd(s.endContainer, s.endOffset);
  const startHost = ascendTo(s.startContainer, endRoot);
  if (startHost) second.setStartBefore(startHost);
  else second.setStart(endRoot, 0);
  return [first, second];
}

/** Ranges for the current selection, resolved inside shadow roots where the browser allows it. */
function selectionRanges(doc: Document, selection: Selection): Range[] {
  const ranges: Range[] = [];
  for (let i = 0; i < selection.rangeCount; i++)
    ranges.push(selection.getRangeAt(i));
  const roots: ShadowRoot[] = [];
  for (const node of [selection.anchorNode, selection.focusNode]) {
    const root = node?.getRootNode() as Partial<ShadowRoot> | undefined;
    if (root?.host && !roots.includes(root as ShadowRoot))
      roots.push(root as ShadowRoot);
  }
  const composed = (
    selection as Selection & {
      getComposedRanges?: (options: {
        shadowRoots: ShadowRoot[];
      }) => StaticRange[];
    }
  ).getComposedRanges;
  if (roots.length && typeof composed === "function") {
    try {
      const rebuilt: Range[] = [];
      for (const s of composed.call(selection, { shadowRoots: roots }))
        rebuilt.push(...composedToRanges(doc, s));
      if (rebuilt.length) return rebuilt;
    } catch {
      // Keep the plain ranges.
    }
  }
  return ranges;
}

function findAnchors(
  cap: Capture,
  root: Node,
  range: Range,
  selected: boolean,
  out: Element[],
): void {
  const tw = cap.walker(root);
  const noExit = () => {};
  let node = advance(tw, root, false, noExit);
  while (node) {
    if (!cap.tick()) return;
    let descend = false;
    if (node.nodeType === 1) {
      const el = node as Element;
      const tag = tagOf(el);
      if (cap.accepts(el, tag)) {
        descend = true;
        if (tag === "a" && el.hasAttribute("href")) {
          if (selected || range.intersectsNode(el)) out.push(el);
        }
        if (el.shadowRoot) {
          findAnchors(
            cap,
            el.shadowRoot,
            range,
            selected || range.intersectsNode(el),
            out,
          );
        }
      }
    }
    node = advance(tw, root, !descend, noExit);
  }
}

function captureSelection(cap: Capture): ContentBlock[] {
  const selection = cap.doc.getSelection();
  if (!selection || selection.isCollapsed) throw new EmptySelectionError();
  const ranges = selectionRanges(cap.doc, selection);
  const text = (
    ranges.map((r) => r.toString()).join("\n\n") || selection.toString()
  )
    .slice(0, MAX_SELECTION_CHARS)
    .replace(/\r\n?/g, "\n");
  if (!normalize(text)) throw new EmptySelectionError();

  const out: ContentBlock[] = [];
  for (const part of text.split(/\n\s*\n/)) {
    const clean = part
      .split("\n")
      .map((line) => normalize(line))
      .filter(Boolean)
      .join("\n");
    if (clean) cap.emit(out, { type: "paragraph", text: clean }, clean.length);
  }
  const anchors: Element[] = [];
  for (const range of ranges) {
    const container = range.commonAncestorContainer;
    const el =
      container.nodeType === 1
        ? (container as Element)
        : container.parentElement;
    if (!el) continue;
    const wrapping = closestAcrossShadow(el, "a[href]");
    if (wrapping) anchors.push(wrapping);
    findAnchors(cap, el, range, false, anchors);
  }
  const seen = new Set<string>();
  const run = newRun();
  for (const a of anchors) {
    const url = cap.linkUrl(a.getAttribute("href"));
    if (!url) continue;
    const label =
      normalize(a.textContent ?? "") ||
      normalize(a.getAttribute("aria-label") ?? "") ||
      url;
    const key = `${url}\n${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cap.emit(run.extras, {
      type: "link",
      url,
      text: label.slice(0, MAX_FIELD_CHARS),
    });
  }
  out.push(...run.extras);
  return out;
}

export async function captureGeneric(
  ctx: CaptureContext,
): Promise<ExportDocument> {
  const cap = new Capture(ctx);
  cap.checkAbort();
  const ld = jsonLd(ctx.document);
  const wantSelection = ctx.options.scope === "selection";
  let blocks: ContentBlock[];
  let scope: string;
  if (wantSelection) {
    blocks = captureSelection(cap);
    scope = "selection";
  } else {
    const root = chooseRoot(cap, ctx.options.scope);
    scope =
      ctx.options.scope === "page"
        ? "page"
        : tagOf(root) === "body"
          ? "page"
          : tagOf(root);
    const frame = newFrame();
    await cap.scanFlow(root, frame);
    cap.flush(frame);
    blocks = frame.out;
  }
  if (cap.limited || cap.truncated)
    cap.warnings.add(
      "Extraction stopped at the node, block or size limit; the export is partial.",
    );
  if (!blocks.length) cap.warnings.add("No extractable content was found.");
  const meta: Meta = {
    ...pageMeta(cap, ld),
    adapter: "generic",
    scope,
    coverage: {
      loaded_content_only: true,
      nodes: cap.nodes,
      blocks: cap.blocks,
      partial: cap.limited || cap.truncated,
    },
  };
  if (cap.warnings.size) meta.warnings = [...cap.warnings];
  return { meta, blocks };
}

/** Converts element subtrees with the generic walker; limits and warnings are shared across calls. */
export interface BodyCapturer {
  /** Blocks for the content of `el`, in document order. */
  blocks(el: Element): Promise<ContentBlock[]>;
  checkAbort(): void;
  maybeYield(): Promise<void>;
  /** Resolve a link against the page, allowing only http(s) and mailto. */
  url(value: string | null | undefined): string | null;
  /** The node or block cap was hit; no more content can be captured. */
  readonly limited: boolean;
  /** An oversized run or block was dropped or cut, but capture can continue. */
  readonly truncated: boolean;
  /** Notes such as closed disclosures that were not extracted; deduplicated. */
  readonly warnings: ReadonlySet<string>;
  readonly nodes: number;
  readonly blockCount: number;
}

/**
 * Lets site adapters reuse the generic HTML-to-blocks conversion for post and comment bodies, so
 * sanitization and link handling stay identical. Landmark chrome is not dropped (like scope "page").
 */
export function createBodyCapturer(
  ctx: CaptureContext,
  exclude?: string,
): BodyCapturer {
  const cap = new Capture({
    ...ctx,
    options: { ...ctx.options, scope: "page" },
  });
  cap.exclude = exclude;
  return {
    async blocks(el) {
      const frame = newFrame();
      cap.seenMedia.clear(); // media repeated in another body is still that body's content
      await cap.scanFlow(el, frame);
      cap.flush(frame);
      return frame.out;
    },
    checkAbort: () => cap.checkAbort(),
    maybeYield: () => cap.maybeYield(),
    url: (value) => cap.url(value, LINK_PROTOCOLS),
    get limited() {
      return cap.limited;
    },
    get truncated() {
      return cap.truncated;
    },
    warnings: cap.warnings,
    get nodes() {
      return cap.nodes;
    },
    get blockCount() {
      return cap.blocks;
    },
  };
}

export const genericAdapter: Adapter = {
  id: "generic",
  matches: () => true,
  capture: captureGeneric,
};
