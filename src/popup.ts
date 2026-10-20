/** Popup (design D9). `initPopup` takes its environment so tests can run it against happy-dom. */

import type { ExportDocument } from "./model.ts";
import { type ExportFormat, exportFilename, mimeFor } from "./naming.ts";
import {
  BUDGETS,
  buildOptions,
  coverageNote,
  DEBOUNCE_MS,
  describeRetry,
  formatKb,
  isRedditUrl,
  isWarning,
  SETTINGS_KEY,
  type Settings,
  sanitizeSettings,
  stripRetryTime,
  summarizeCoverage,
} from "./popup-logic.ts";
import { toJsonl } from "./serialize/jsonl.ts";
import { toMarkdown } from "./serialize/markdown.ts";

export interface PopupEnv {
  document: Document;
  chrome: {
    tabs: {
      query(q: {
        active: boolean;
        currentWindow: boolean;
      }): Promise<Array<{ id?: number; url?: string }>>;
    };
    runtime: { sendMessage(message: unknown): Promise<unknown> };
    storage: {
      local: {
        get(key: string): Promise<Record<string, unknown>>;
        set(items: Record<string, unknown>): Promise<void>;
      };
    };
  };
  writeClipboard(text: string): Promise<void>;
  download(filename: string, mime: string, text: string): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
}

type State = "loading" | "ready" | "error" | "unsupported" | "empty";

/** Object URL plus `<a download>`: the manifest has no `downloads` permission. */
export function downloadFile(
  doc: Document,
  filename: string,
  mime: string,
  text: string,
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Preview cap in characters; Copy and Save always use the full text. */
export const PREVIEW_MAX = 200_000;
const CONFIRM_MS = 1500;

export async function initPopup(
  env: PopupEnv,
): Promise<{ ready: Promise<void> }> {
  const d = env.document;
  const $ = <T extends HTMLElement>(id: string): T => {
    const el = d.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el as T;
  };
  const els = {
    host: $("host"),
    nItems: $("n-items"),
    lItems: $("l-items"),
    nTrunc: $("n-truncated"),
    statTrunc: $("stat-truncated"),
    nSize: $("n-size"),
    note: $("note"),
    problem: $("problem"),
    problemMessage: $("problem-message"),
    problemRetry: $("problem-retry"),
    copy: $<HTMLButtonElement>("copy"),
    save: $<HTMLButtonElement>("save"),
    refresh: $<HTMLButtonElement>("refresh"),
    confirm: $("confirm"),
    advanced: $<HTMLDetailsElement>("advanced"),
    preview: $<HTMLTextAreaElement>("preview"),
    previewNote: $("preview-note"),
    scope: $<HTMLSelectElement>("scope"),
    budget: $<HTMLSelectElement>("budget"),
    reddit: $<HTMLFieldSetElement>("reddit"),
    sort: $<HTMLSelectElement>("reddit-sort"),
    more: $<HTMLInputElement>("reddit-more"),
  };
  const formatInputs = [
    ...d.querySelectorAll<HTMLInputElement>('input[name="format"]'),
  ];

  let settings: Settings = sanitizeSettings(undefined);
  let tab: { id: number; url: string } | null = null;
  let reddit = false;
  let doc: ExportDocument | null = null;
  const texts = new Map<ExportFormat, string>();
  const sizes = new Map<ExportFormat, number>();
  let seq = 0;
  let state: State = "loading";
  let saveTimer: unknown;
  let captureTimer: unknown;
  let copyTimer: unknown;
  let saveLabelTimer: unknown;
  let tickTimer: unknown;
  let copyFlash: string | null = null;
  let saveFlash: string | null = null;
  let retryAt = 0;
  let previewShown = "";

  const itemsDefault = () => (reddit ? "Comments" : "Blocks");

  const updateLabels = () => {
    els.copy.textContent = copyFlash ?? "Copy";
    els.save.textContent = saveFlash ?? `Save .${settings.format}`;
    els.refresh.textContent = state === "error" ? "Retry" : "Refresh";
  };

  const updateRefresh = () => {
    els.refresh.disabled =
      state === "unsupported" ||
      state === "loading" ||
      (state === "error" && retryAt > env.now());
  };

  const setState = (next: State) => {
    state = next;
    d.body.dataset["state"] = next;
    const usable = next === "ready";
    els.copy.disabled = !usable;
    els.save.disabled = !usable;
    updateLabels();
    updateRefresh();
  };

  const clearNumbers = () => {
    for (const el of [els.nItems, els.nTrunc, els.nSize]) el.textContent = "–";
    els.lItems.textContent = itemsDefault();
    els.statTrunc.classList.remove("warn");
  };

  const textFor = (format: ExportFormat): string => {
    if (!doc) return "";
    let text = texts.get(format);
    if (text === undefined) {
      text = format === "md" ? toMarkdown(doc) : toJsonl(doc);
      texts.set(format, text);
    }
    return text;
  };

  const sizeFor = (format: ExportFormat): number => {
    let size = sizes.get(format);
    if (size === undefined) {
      size = new TextEncoder().encode(textFor(format)).length;
      sizes.set(format, size);
    }
    return size;
  };

  const flash = (which: "copy" | "save", label: string) => {
    els.confirm.textContent = label;
    if (which === "copy") {
      copyFlash = label;
      env.clearTimer(copyTimer);
      copyTimer = env.setTimer(() => {
        copyFlash = null;
        updateLabels();
      }, CONFIRM_MS);
    } else {
      saveFlash = label;
      env.clearTimer(saveLabelTimer);
      saveLabelTimer = env.setTimer(() => {
        saveFlash = null;
        updateLabels();
      }, CONFIRM_MS);
    }
    updateLabels();
  };

  const syncPreview = () => {
    if (!els.advanced.open) return;
    const full = state === "ready" ? textFor(settings.format) : "";
    const cut = full.length > PREVIEW_MAX;
    const text = cut ? full.slice(0, PREVIEW_MAX) : full;
    els.previewNote.hidden = !cut;
    if (text === previewShown) return;
    previewShown = text;
    els.preview.value = text;
    els.preview.scrollTop = 0;
  };

  const renderResult = () => {
    if (!doc) return;
    const summary = summarizeCoverage(doc);
    els.nItems.textContent = String(summary.items);
    els.lItems.textContent = summary.itemsLabel;
    els.nTrunc.textContent =
      summary.truncated === null ? "–" : String(summary.truncated);
    els.statTrunc.classList.toggle(
      "warn",
      (summary.truncated ?? 0) > 0 || summary.partial,
    );
    els.nSize.textContent = formatKb(sizeFor(settings.format));
    els.note.textContent = coverageNote(summary);
    els.note.classList.toggle("warn", isWarning(summary));
    updateLabels();
    syncPreview();
  };

  const tick = () => {
    env.clearTimer(tickTimer);
    const left = retryAt - env.now();
    if (state !== "error" || left <= 0) {
      els.problemRetry.hidden = true;
      updateRefresh();
      return;
    }
    els.problemRetry.hidden = false;
    els.problemRetry.textContent = describeRetry(retryAt, env.now());
    updateRefresh();
    tickTimer = env.setTimer(tick, 1000);
  };

  const showProblem = (message: string, until?: number) => {
    els.problem.hidden = false;
    retryAt = until ?? 0;
    els.problemMessage.textContent =
      until === undefined ? message : stripRetryTime(message);
    tick();
  };

  const persist = () => {
    env.clearTimer(saveTimer);
    saveTimer = undefined;
    env.chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
  };
  const saveDebounced = () => {
    env.clearTimer(saveTimer);
    saveTimer = env.setTimer(persist, DEBOUNCE_MS);
  };
  /** Closing the popup must not lose a pending write. */
  const flushSettings = () => {
    if (saveTimer !== undefined) persist();
  };

  const beginLoading = (note = "Capturing…") => {
    setState("loading");
    els.problem.hidden = true;
    retryAt = 0;
    clearNumbers();
    els.note.textContent = note;
    els.note.classList.remove("warn");
    els.confirm.textContent = "";
    els.preview.value = "";
    els.previewNote.hidden = true;
    previewShown = "";
  };

  async function capture(fresh: boolean): Promise<void> {
    if (!tab) return;
    const mine = ++seq;
    env.clearTimer(captureTimer);
    const hadFocus = d.activeElement === els.refresh;
    beginLoading();
    let reply: unknown;
    try {
      reply = await env.chrome.runtime.sendMessage({
        type: "capture",
        tabId: tab.id,
        options: buildOptions(settings, reddit, fresh),
      });
    } catch {
      reply = null;
    }
    // A newer request owns the popup now.
    if (mine !== seq) return;
    const r = reply as {
      ok?: boolean;
      doc?: ExportDocument;
      code?: string;
      message?: string;
      retryAt?: number;
    } | null;
    if (!r?.ok || !r.doc) {
      doc = null;
      texts.clear();
      sizes.clear();
      els.note.textContent = "";
      if (r?.code === "unsupported_page") {
        setState("unsupported");
        showProblem(r.message ?? "This page cannot be exported.");
        return;
      }
      setState("error");
      showProblem(
        r?.code === "superseded"
          ? "The capture was replaced and did not finish. Retry."
          : typeof r?.message === "string" && r.message
            ? r.message
            : "Capture failed. Reload the tab and retry.",
        typeof r?.retryAt === "number" ? r.retryAt : undefined,
      );
      if (hadFocus && !els.refresh.disabled) els.refresh.focus();
      return;
    }
    doc = r.doc;
    texts.clear();
    sizes.clear();
    if (doc.blocks.length === 0) {
      setState("empty");
      clearNumbers();
      els.note.textContent =
        "Nothing to export on this page. Try the whole page scope in Advanced, or Refresh.";
      return;
    }
    setState("ready");
    renderResult();
    if (hadFocus) els.copy.focus();
  }

  const scheduleCapture = () => {
    env.clearTimer(captureTimer);
    // Block Copy and Save at once: the shown text no longer matches the options.
    beginLoading();
    captureTimer = env.setTimer(() => void capture(false), DEBOUNCE_MS);
  };

  const syncControls = () => {
    for (const input of formatInputs)
      input.checked = input.value === settings.format;
    updateLabels();
    els.advanced.open = settings.advanced;
    els.scope.value = settings.scope;
    els.budget.value =
      settings.maxBlocks === null ? "" : String(settings.maxBlocks);
    els.sort.value = settings.redditSort;
    els.more.value = String(settings.redditMore);
  };

  // Listeners first: nothing here waits on storage or the network.
  for (const input of formatInputs)
    input.addEventListener("change", () => {
      if (!input.checked) return;
      settings = { ...settings, format: input.value as ExportFormat };
      persist();
      updateLabels();
      if (state === "ready") renderResult();
    });

  els.advanced.addEventListener("toggle", () => {
    if (settings.advanced !== els.advanced.open) {
      settings = { ...settings, advanced: els.advanced.open };
      persist();
    }
    syncPreview();
  });

  const onOption =
    (patch: () => Partial<Settings>, debounce = false) =>
    () => {
      settings = { ...settings, ...patch() };
      if (debounce) saveDebounced();
      else persist();
      scheduleCapture();
    };
  els.scope.addEventListener(
    "change",
    onOption(() => ({ scope: els.scope.value as Settings["scope"] })),
  );
  els.budget.addEventListener(
    "change",
    onOption(() => {
      const value = BUDGETS.find((b) => String(b) === els.budget.value);
      return { maxBlocks: value ?? null };
    }),
  );
  els.sort.addEventListener(
    "change",
    onOption(() => ({ redditSort: els.sort.value as Settings["redditSort"] })),
  );
  els.more.addEventListener("change", () => {
    const next = sanitizeSettings({ redditMore: Number(els.more.value) });
    const valid =
      els.more.value !== "" && Number(els.more.value) === next.redditMore;
    if (!valid) {
      els.more.value = String(settings.redditMore);
      return;
    }
    onOption(() => ({ redditMore: next.redditMore }), true)();
  });

  els.copy.addEventListener("click", () => {
    if (state !== "ready") return;
    env.writeClipboard(textFor(settings.format)).then(
      () => flash("copy", "Copied"),
      () => flash("copy", "Copy failed"),
    );
  });
  els.save.addEventListener("click", () => {
    if (state !== "ready" || !doc) return;
    const format = settings.format;
    try {
      env.download(
        exportFilename(doc.meta.url, doc.meta.captured_at, format),
        mimeFor(format),
        textFor(format),
      );
      flash("save", "Saved");
    } catch {
      flash("save", "Save failed");
    }
  });
  els.refresh.addEventListener("click", () => {
    if (!els.refresh.disabled) void capture(true);
  });

  d.defaultView?.addEventListener("pagehide", flushSettings);
  d.addEventListener("visibilitychange", () => {
    if (d.visibilityState === "hidden") flushSettings();
  });

  const ready = (async () => {
    const [stored, tabs] = await Promise.all([
      env.chrome.storage.local.get(SETTINGS_KEY).catch(() => ({})),
      env.chrome.tabs
        .query({ active: true, currentWindow: true })
        .catch(() => []),
    ]);
    settings = sanitizeSettings(
      (stored as Record<string, unknown>)[SETTINGS_KEY],
    );
    syncControls();
    const active = tabs[0];
    if (!active || typeof active.id !== "number") {
      setState("unsupported");
      showProblem("No active tab to export.");
      return;
    }
    const url = active.url ?? "";
    tab = { id: active.id, url };
    reddit = isRedditUrl(url);
    els.reddit.disabled = !reddit;
    els.lItems.textContent = itemsDefault();
    try {
      els.host.textContent = new URL(url).hostname;
    } catch {
      els.host.textContent = "";
    }
    await capture(false);
  })();
  return { ready };
}

const chromeApi = (
  globalThis as { chrome?: PopupEnv["chrome"] & { runtime: { id?: string } } }
).chrome;
if (chromeApi?.runtime?.id) {
  void initPopup({
    document,
    chrome: chromeApi,
    writeClipboard: (text) => navigator.clipboard.writeText(text),
    download: (filename, mime, text) =>
      downloadFile(document, filename, mime, text),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  });
}
