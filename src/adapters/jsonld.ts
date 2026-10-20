/** schema.org metadata from application/ld+json. Input is untrusted: parse only, never evaluate. */

export interface JsonLdMeta {
  title?: string;
  description?: string;
  author?: string;
  published?: string;
  language?: string;
  site?: string;
}

export const MAX_JSONLD_CHARS = 1_000_000;
/** Total across all scripts on a page. */
export const MAX_JSONLD_TOTAL_CHARS = 2_000_000;
const MAX_ENTITIES = 2000;
const MAX_FIELD = 2000;

const TYPES = new Set([
  "Article",
  "NewsArticle",
  "BlogPosting",
  "TechArticle",
  "ScholarlyArticle",
  "Report",
  "SocialMediaPosting",
  "LiveBlogPosting",
  "DiscussionForumPosting",
  "QAPage",
  "Question",
]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_FIELD) : undefined;
}

/** Flatten arrays, @graph and nested objects into one list, bounded in size. */
function entities(roots: unknown[]): Json[] {
  const out: Json[] = [];
  const stack: unknown[] = [...roots].reverse();
  while (stack.length && out.length < MAX_ENTITIES) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
    } else if (isObject(value)) {
      out.push(value);
      const graph = value["@graph"];
      if (graph !== undefined) stack.push(graph);
    }
  }
  return out;
}

function typesOf(entity: Json): string[] {
  const raw = entity["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.replace(/^.*[/#]/, ""));
}

/** Resolve strings, {name}, {@id} references and arrays of them to a name. */
function nameOf(
  value: unknown,
  byId: Map<string, Json>,
  depth = 0,
): string | undefined {
  if (depth > 3) return undefined;
  if (typeof value === "string") return str(value);
  if (Array.isArray(value)) {
    const names = value
      .slice(0, 10)
      .map((v) => nameOf(v, byId, depth + 1))
      .filter((n): n is string => !!n);
    return names.length ? names.join(", ") : undefined;
  }
  if (!isObject(value)) return undefined;
  const direct = str(value["name"]);
  if (direct) return direct;
  const ref = str(value["@id"]);
  const target = ref ? byId.get(ref) : undefined;
  return target && target !== value
    ? nameOf(target["name"], byId, depth + 1)
    : undefined;
}

/**
 * Parse ld+json script texts. Malformed or oversized blocks are skipped. The first
 * Article / DiscussionForumPosting / QAPage entity (document order) wins; missing fields
 * fall back to its mainEntity (QAPage -> Question).
 */
export function parseJsonLd(texts: Iterable<string>): JsonLdMeta {
  const roots: unknown[] = [];
  let budget = MAX_JSONLD_TOTAL_CHARS;
  for (const text of texts) {
    if (text.length > budget) break; // total budget spent
    if (text.length > MAX_JSONLD_CHARS) continue;
    budget -= text.length;
    try {
      roots.push(JSON.parse(text));
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }
  const all = entities(roots);
  const byId = new Map<string, Json>();
  for (const entity of all) {
    const id = str(entity["@id"]);
    if (id && !byId.has(id)) byId.set(id, entity);
  }
  const chosen = all.find((e) => typesOf(e).some((t) => TYPES.has(t)));
  if (!chosen) return {};

  const candidates: Json[] = [chosen];
  const main = chosen["mainEntity"];
  if (isObject(main)) candidates.push(main);
  const mainRef = isObject(main) ? byId.get(str(main["@id"]) ?? "") : undefined;
  if (mainRef) candidates.push(mainRef);

  const pick = <T>(get: (e: Json) => T | undefined): T | undefined => {
    for (const e of candidates) {
      const v = get(e);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const meta: JsonLdMeta = {};
  const set = <K extends keyof JsonLdMeta>(key: K, v: string | undefined) => {
    if (v) meta[key] = v;
  };
  set(
    "title",
    pick((e) => str(e["headline"]) ?? str(e["name"])),
  );
  set(
    "description",
    pick((e) => str(e["description"]) ?? str(e["abstract"])),
  );
  set(
    "author",
    pick((e) => nameOf(e["author"], byId)),
  );
  set(
    "published",
    pick((e) => str(e["datePublished"]) ?? str(e["dateCreated"])),
  );
  set(
    "language",
    pick((e) => str(e["inLanguage"])),
  );
  set(
    "site",
    pick((e) => nameOf(e["publisher"], byId)),
  );
  return meta;
}
