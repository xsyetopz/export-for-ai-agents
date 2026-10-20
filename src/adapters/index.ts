/** Adapter registry: first match wins, generic is last (design D6). */

import { genericAdapter } from "./generic.ts";
import { githubAdapter } from "./github.ts";
import { hackerNewsAdapter } from "./hackernews.ts";
import { redditAdapter } from "./reddit.ts";
import { stackExchangeAdapter } from "./stackexchange.ts";
import type { Adapter } from "./types.ts";

/** Site adapters come before generic; reddit, Hacker News, GitHub, Stack Exchange. */
export const adapters: readonly Adapter[] = [
  redditAdapter,
  hackerNewsAdapter,
  githubAdapter,
  stackExchangeAdapter,
  genericAdapter,
];

/** First adapter whose `matches` accepts the URL. A throwing matcher counts as no match. */
export function selectAdapter(
  url: string,
  list: readonly Adapter[] = adapters,
): Adapter {
  for (const adapter of list) {
    try {
      if (adapter.matches(url)) return adapter;
    } catch {
      // A broken matcher must not hide the adapters after it.
    }
  }
  return genericAdapter;
}

export { genericAdapter } from "./generic.ts";
export * from "./types.ts";
