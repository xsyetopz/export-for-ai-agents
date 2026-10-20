// Generates examples/ from the fixture documents. `bun run examples` rewrites them.
import { mkdir, writeFile } from "node:fs/promises";
import { toJsonl } from "../src/serialize/jsonl.ts";
import { toMarkdown } from "../src/serialize/markdown.ts";
import { articleDoc, threadDoc } from "../tests/fixtures/documents.ts";

const sources = { article: articleDoc, thread: threadDoc };

/** Returns example file paths (relative to the repo root) mapped to content. */
export function buildExamples(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, doc] of Object.entries(sources)) {
    // Front-matter title plus body H1 is the serializer's intended output, so MD025 is disabled.
    // The directive goes after the front matter, which must stay first.
    out[`examples/${name}.md`] = toMarkdown(doc).replace(
      /^(---\n[\s\S]*?\n---\n)/,
      "$1<!-- markdownlint-disable-file MD025 -->\n",
    );
    out[`examples/${name}.jsonl`] = toJsonl(doc);
  }
  return out;
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url);
  await mkdir(new URL("examples/", root), { recursive: true });
  for (const [path, content] of Object.entries(buildExamples()))
    await writeFile(new URL(path, root), content);
}
