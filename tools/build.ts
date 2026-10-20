import { cp, mkdir, rm } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  outdir: dist,
  target: "browser",
  minify: false,
  sourcemap: "linked",
} as const;

const results = [
  await Bun.build({
    ...common,
    entrypoints: [`${root}src/background.ts`, `${root}src/popup.ts`],
    format: "esm",
  }),
  // Injected via scripting.executeScript({ files: ["content.js"] }), so no module syntax.
  await Bun.build({
    ...common,
    entrypoints: [`${root}src/content.ts`],
    format: "iife",
  }),
];

for (const result of results) {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await cp(`${root}static`, dist, { recursive: true });
console.log("built dist/");
