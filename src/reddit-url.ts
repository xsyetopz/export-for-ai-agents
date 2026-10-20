/** Reddit thread URL detection, shared by the gate, the popup and the adapter. */

/** Thread id and origin from a Reddit URL, or null when it is not a thread. */
export function redditTarget(
  value: string,
): { id: string; origin: string } | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !/^(?:www\.|old\.|new\.|sh\.)?reddit\.com$/.test(url.hostname)
    )
      return null;
    const match =
      /^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|\.json|$)/i.exec(
        url.pathname,
      ) ?? /^\/gallery\/([a-z0-9]+)(?:\/|$)/i.exec(url.pathname);
    return match?.[1]
      ? { id: match[1].toLowerCase(), origin: url.origin }
      : null;
  } catch {
    return null;
  }
}
