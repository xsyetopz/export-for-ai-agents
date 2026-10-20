/** JSON Lines serializer (design D4). */

import { type ExportDocument, SCHEMA_ID } from "../model.ts";

/** One JSON object per line; JSON.stringify escapes control characters and never emits raw LF. */
function line(value: object): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function toJsonl(doc: ExportDocument): string {
  const lines = [line({ $schema: SCHEMA_ID, type: "document", ...doc.meta })];
  for (const block of doc.blocks) {
    const { type, ...rest } = block;
    lines.push(line({ type, ...rest }));
  }
  return `${lines.join("\n")}\n`;
}
