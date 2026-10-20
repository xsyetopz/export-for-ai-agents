/**
 * Stack Exchange adapter (design D6): DOM only, question pages on the network's hosts. Question,
 * answers (score, accepted) and comments; tags are kept as a paragraph because the model has no
 * tag field. Bodies go through the generic converter. Page content is untrusted.
 */

import type { Block, ContentBlock, ExportDocument } from "../model.ts";
import { createBodyCapturer } from "./generic.ts";
import {
  clean,
  isoDate,
  parseInteger,
  textOf,
  threadMeta,
} from "./thread-dom.ts";
import {
  type Adapter,
  type CaptureContext,
  NotThisLayoutError,
} from "./types.ts";

const MAX_ITEMS = 5000;
const CHROME = "clipboard-copy,.snippet-ctas";
const NETWORK_HOSTS = new Set([
  "stackoverflow.com",
  "superuser.com",
  "serverfault.com",
  "askubuntu.com",
  "mathoverflow.net",
  "stackapps.com",
]);

function isNetworkHost(host: string): boolean {
  if (NETWORK_HOSTS.has(host.replace(/^meta\./, ""))) return true;
  // Sites like math.stackexchange.com and localized ru.stackoverflow.com.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(stackexchange|stackoverflow)\.com$/.test(
    host,
  );
}

export function stackExchangeTarget(
  value: string,
): { host: string; id: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !isNetworkHost(url.hostname)) return null;
    const match = /^\/questions\/(\d+)(?:\/|$)/.exec(url.pathname);
    return match?.[1] ? { host: url.hostname, id: match[1] } : null;
  } catch {
    return null;
  }
}

/** Last signature of a post is its author's (earlier ones are editors). */
function signature(post: Element): Element | null {
  const all = post.querySelectorAll(".post-signature");
  return all[all.length - 1] ?? null;
}

function postDate(post: Element): string | undefined {
  const sig = signature(post);
  if (!sig) return undefined;
  const el = sig.querySelector(".user-action-time [title], time[datetime]");
  return isoDate(el?.getAttribute("datetime") ?? el?.getAttribute("title"));
}

function postScore(post: Element): number | undefined {
  const el = post.querySelector(".js-vote-count");
  return parseInteger(el?.getAttribute("data-value") ?? el?.textContent);
}

async function capture(ctx: CaptureContext): Promise<ExportDocument> {
  const target = stackExchangeTarget(ctx.url);
  if (!target)
    throw new NotThisLayoutError("This is not a Stack Exchange question.");
  const doc = ctx.document;
  const question = doc.querySelector("#question");
  if (!question)
    throw new NotThisLayoutError("No Stack Exchange question found.");

  const bodies = createBodyCapturer(ctx, CHROME);
  bodies.checkAbort();
  const warnings: string[] = [];
  const blocks: Block[] = [];
  let items = 0;
  let stopped = false;
  let commentCount = 0;
  let unloadedComments = false;

  const title =
    textOf(doc, "#question-header h1") || textOf(doc, "h1[itemprop='name']");
  const body = async (post: Element): Promise<ContentBlock[]> => {
    const el = post.querySelector(".js-post-body, .post-text");
    return el ? bodies.blocks(el) : [];
  };
  const room = () => {
    if (items < MAX_ITEMS && !bodies.limited) return true;
    if (!stopped)
      warnings.push("Stopped at the capture limit; the thread is partial.");
    stopped = true;
    return false;
  };
  const comments = async (post: Element, parent: string, depth: number) => {
    for (const row of Array.from(post.querySelectorAll(".comments .comment"))) {
      await bodies.maybeYield();
      if (!room()) return;
      const copy = row.querySelector(".comment-copy");
      if (!copy) continue;
      const rawId =
        row.getAttribute("data-comment-id") ?? row.id.replace(/^comment-/, "");
      const author = textOf(row, ".comment-user") || undefined;
      const dateEl = row.querySelector(
        ".comment-date [title], .comment-date time",
      );
      const date = isoDate(
        dateEl?.getAttribute("datetime") ?? dateEl?.getAttribute("title"),
      );
      const score = parseInteger(textOf(row, ".comment-score"));
      const content = await bodies.blocks(copy);
      blocks.push({
        type: "comment",
        id: rawId ? `c${rawId}` : `${parent}-c${commentCount}`,
        parent_id: parent,
        depth,
        ...(author ? { author } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(date ? { date } : {}),
        ...(content.length ? { content } : {}),
      });
      items++;
      commentCount++;
    }
    if (post.querySelector(".js-show-link.comments-link:not(.dno)"))
      unloadedComments = true;
  };

  const qId = `q${question.getAttribute("data-questionid") || target.id}`;
  const tags = Array.from(question.querySelectorAll(".post-taglist .post-tag"))
    .map((el) => clean(el.textContent))
    .filter(Boolean);
  const qContent = await body(question);
  if (tags.length)
    qContent.push({ type: "paragraph", text: `Tags: ${tags.join(", ")}` });
  const qAuthor =
    textOf(signature(question) ?? question, ".user-details a") || undefined;
  const qScore = postScore(question);
  const qDate = postDate(question);
  blocks.push({
    type: "post",
    id: qId,
    parent_id: null,
    depth: 0,
    ...(title ? { title } : {}),
    ...(qAuthor ? { author: qAuthor } : {}),
    ...(qScore !== undefined ? { score: qScore } : {}),
    ...(qDate ? { date: qDate } : {}),
    ...(qContent.length ? { content: qContent } : {}),
  });
  items++;
  await comments(question, qId, 0);

  let answers = 0;
  let accepted = 0;
  for (const answer of Array.from(doc.querySelectorAll("#answers .answer"))) {
    await bodies.maybeYield();
    if (!room()) break;
    const rawId =
      answer.getAttribute("data-answerid") ?? answer.id.replace(/^answer-/, "");
    const aId = rawId ? `a${rawId}` : `${qId}-a${answers}`;
    const isAccepted =
      answer.classList.contains("accepted-answer") ||
      answer.getAttribute("itemprop") === "acceptedAnswer";
    const author =
      textOf(signature(answer) ?? answer, ".user-details a") || undefined;
    const score = postScore(answer);
    const date = postDate(answer);
    const content = await body(answer);
    blocks.push({
      type: "answer",
      id: aId,
      parent_id: qId,
      depth: 0,
      ...(isAccepted ? { accepted: true } : {}),
      ...(author ? { author } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(date ? { date } : {}),
      ...(content.length ? { content } : {}),
    });
    items++;
    answers++;
    if (isAccepted) accepted++;
    await comments(answer, aId, 1);
  }
  if (unloadedComments)
    warnings.push(
      'Some comments are collapsed ("show more comments") and were not captured.',
    );
  const reported = parseInteger(
    doc.querySelector("[data-answercount]")?.getAttribute("data-answercount"),
  );
  const paginated = doc.querySelector("#answers .s-pagination") !== null;
  const missingAnswers = reported !== undefined && answers < reported;
  if (paginated || missingAnswers)
    warnings.push(
      `Captured ${answers}${reported !== undefined ? ` of ${reported}` : ""} answers; others are on other pages or not loaded.`,
    );
  if (bodies.limited)
    warnings.push("Extraction hit a size limit; some content is partial.");
  if (bodies.truncated) warnings.push("An oversized block was cut or dropped.");
  for (const w of bodies.warnings) warnings.push(w);

  const canonical = bodies.url(
    doc.querySelector("link[rel='canonical']")?.getAttribute("href"),
  );
  return {
    meta: threadMeta(ctx, {
      adapter: "stackexchange",
      title: title || "Stack Exchange question",
      site: target.host,
      canonical: canonical ?? undefined,
      author: qAuthor,
      published: qDate,
      coverage: {
        loaded_content_only: true,
        answers_captured: answers,
        answers_reported: reported ?? null,
        accepted_answers: accepted,
        comments_captured: commentCount,
        tags: tags.length,
        partial:
          stopped ||
          unloadedComments ||
          paginated ||
          missingAnswers ||
          bodies.limited ||
          bodies.truncated,
      },
      warnings,
    }),
    blocks,
  };
}

export const stackExchangeAdapter: Adapter = {
  id: "stackexchange",
  matches: (url) => stackExchangeTarget(url) !== null,
  capture,
};
