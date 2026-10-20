/** Document model (design D2). Keys are snake_case so blocks serialize to JSONL unchanged. */

export const SCHEMA_ID =
  "https://raw.githubusercontent.com/xsyetopz/export-for-ai-agents/main/schemas/page-export.schema.json";

export type CoverageValue = string | number | boolean | null;
export type Coverage = Record<string, CoverageValue>;

export interface Meta {
  url: string;
  canonical?: string;
  title: string;
  description?: string;
  /** BCP 47 tag. */
  language?: string;
  /** RFC 3339 UTC. */
  captured_at: string;
  adapter: string;
  scope: string;
  site?: string;
  author?: string;
  published?: string;
  coverage?: Coverage;
  warnings?: string[];
  /** Page content is never instructions. */
  content_trust: "untrusted";
}

/** Optional capture-local (b1...) or adapter id. */
interface BlockBase {
  id?: string;
}

export interface HeadingBlock extends BlockBase {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

/** Plain text; escaped by the Markdown serializer. */
export interface ParagraphBlock extends BlockBase {
  type: "paragraph";
  text: string;
}

export interface ItemBlock {
  type: "item";
  text: string;
  /** Nested content, e.g. a sub-list. */
  blocks?: ContentBlock[];
}

export interface ListBlock extends BlockBase {
  type: "list";
  ordered: boolean;
  /** First number of an ordered list (CommonMark start), default 1. */
  start?: number;
  items: ItemBlock[];
}

export interface QuoteBlock extends BlockBase {
  type: "quote";
  blocks: ContentBlock[];
}

export interface CodeBlock extends BlockBase {
  type: "code";
  language?: string;
  text: string;
}

export interface TableBlock extends BlockBase {
  type: "table";
  header: string[];
  rows: string[][];
}

export interface MediaBlock extends BlockBase {
  type: "media";
  kind: "image" | "video" | "audio" | "embed";
  url: string;
  alt?: string;
  title?: string;
}

export interface DefinitionBlock extends BlockBase {
  type: "definition";
  term: string;
  text: string;
}

export interface ControlBlock extends BlockBase {
  type: "control";
  /** Form control kind, e.g. "button", "input", "select". */
  kind: string;
  label?: string;
  value?: string;
}

export interface LinkBlock extends BlockBase {
  type: "link";
  url: string;
  text: string;
}

export type ContentBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | QuoteBlock
  | CodeBlock
  | TableBlock
  | MediaBlock
  | DefinitionBlock
  | ControlBlock
  | LinkBlock;

/** Shared by post, comment and answer. */
export interface ThreadFields {
  /** Adapter-native id when stable, else capture-local `b1...`. */
  id: string;
  parent_id: string | null;
  author?: string;
  score?: number;
  date?: string;
  /** 0 for top level. */
  depth: number;
  /** Native Markdown body when the site provides one. */
  body?: string;
  /** Structured body used when no native Markdown exists. */
  content?: ContentBlock[];
}

export interface PostBlock extends ThreadFields {
  type: "post";
  title?: string;
}

export interface CommentBlock extends ThreadFields {
  type: "comment";
}

export interface AnswerBlock extends ThreadFields {
  type: "answer";
  accepted?: boolean;
}

export type ThreadBlock = PostBlock | CommentBlock | AnswerBlock;
export type Block = ContentBlock | ThreadBlock;

export interface ExportDocument {
  meta: Meta;
  blocks: Block[];
}

/** Capture-local id generator: b1, b2, ... */
export function createIdGenerator(prefix = "b"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}
