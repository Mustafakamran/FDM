import { downloadDir } from "@tauri-apps/api/path";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useTransfers, filenameFromUrl, HTTP_ACCOUNT_ID } from "../store/transfers";
import { useToasts } from "../store/toast";
import { getAskWhereToSave } from "./ask-where";
import type { DownloadItem } from "./tauri/commands";

/**
 * Account id for browser-captured social/video URLs handled by the bundled
 * yt-dlp sidecar. Classified as the SECONDARY lane (see `laneOf`), so these
 * never disturb Drive/Dropbox footage work.
 */
export const YTDLP_ACCOUNT_ID = "ytdlp";

/** localStorage key for the user's chosen default download folder. */
export const FOLDER_KEY = "default_download_folder";

/** The kind of capture the browser extension forwards. */
export type IngestKind = "file" | "media";

/**
 * Shape of the Rust `ingest-url` event payload (also the JSON body the extension
 * POSTs to /fdm/ingest). `url` + `kind` are required; the rest are additive
 * refinements from the IDM-style grab:
 *  - `filename`  — the suggested name (overrides the URL-derived guess).
 *  - `referrer` / `cookie` / `ua` — request headers threaded into the download so
 *    cookie/referer-gated direct links (mediafire/filecr/"save image as") work.
 *  - `prompt`    — force the native save dialog for this capture regardless of the
 *    `askWhereToSave` setting.
 */
export interface IngestPayload {
  url: string;
  kind: IngestKind;
  filename?: string;
  referrer?: string;
  cookie?: string;
  ua?: string;
  prompt?: boolean;
}

/**
 * Build the per-download request headers from the ingest payload. Only the keys
 * that are actually present are emitted, so we never override the downloader's
 * default User-Agent / send empty Referer/Cookie. Returns undefined when none are
 * present (keeps the item lean and the headers field truly optional). Pure.
 */
export function headersForPayload(payload: IngestPayload): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (payload.referrer) headers.Referer = payload.referrer;
  if (payload.cookie) headers.Cookie = payload.cookie;
  if (payload.ua) headers["User-Agent"] = payload.ua;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Best-effort filename for the suggested save path: explicit filename, else from URL. */
export function suggestedName(payload: IngestPayload): string {
  return payload.filename?.trim() || filenameFromUrl(payload.url);
}

/**
 * Split an OS path chosen in the save dialog into a destination folder + leaf
 * name. Handles both POSIX (`/`) and Windows (`\`) separators. If there is no
 * separator the whole string is treated as the name and the folder is empty.
 * Pure; unit-tested.
 */
export function splitSavePath(chosen: string): { dir: string; name: string } {
  const idx = Math.max(chosen.lastIndexOf("/"), chosen.lastIndexOf("\\"));
  if (idx < 0) return { dir: "", name: chosen };
  return { dir: chosen.slice(0, idx), name: chosen.slice(idx + 1) };
}

/**
 * Map an ingest kind to the engine account id:
 *  - "media" -> yt-dlp sidecar (social/video)
 *  - "file"  -> generic streaming HTTP download
 * Pure; no dependencies — unit-tested.
 */
export function accountIdForKind(kind: IngestKind): string {
  return kind === "media" ? YTDLP_ACCOUNT_ID : HTTP_ACCOUNT_ID;
}

/**
 * Build the download item for an ingested URL. The backend resolves the real
 * filename, so `name` is a best-effort guess (the suggested filename when given,
 * else derived from the URL) and size is unknown. Optional `headers` carry the
 * Referer/Cookie/User-Agent for gated direct downloads. Pure; unit-tested.
 */
export function itemForUrl(
  url: string,
  name?: string,
  headers?: Record<string, string>,
): DownloadItem {
  return {
    path: "",
    name: name?.trim() || filenameFromUrl(url),
    isDir: false,
    size: 0,
    id: url,
    ...(headers ? { headers } : {}),
  };
}

/**
 * Resolve the destination folder for an ingested download: the user's configured
 * default folder, else the OS Downloads dir. Falls back to "" only if neither is
 * available (the engine then prompts / errors).
 */
export async function resolveDest(): Promise<string> {
  const configured = localStorage.getItem(FOLDER_KEY);
  if (configured) return configured;
  try {
    return await downloadDir();
  } catch {
    return "";
  }
}

/**
 * Enqueue a single ingested URL and toast it.
 *
 * Destination resolution:
 *  - If the `askWhereToSave` setting is on OR the payload sets `prompt`, pop a
 *    native save dialog seeded with `<defaultFolder>/<suggested filename>`. If the
 *    user cancels, abort with no download. Otherwise split the chosen path into a
 *    dest folder + item name.
 *  - Else drop straight into the default download folder under the suggested name.
 *
 * Referer/Cookie/User-Agent from the payload ride along on `item.headers`.
 * Exported (and dependency-injectable) so it can be unit-tested without Tauri.
 */
export async function ingest(
  payload: IngestPayload,
  deps: {
    enqueue?: (accountId: string, items: DownloadItem[], dest: string) => void;
    pushToast?: (msg: string) => void;
    dest?: () => Promise<string>;
    askWhereToSave?: () => boolean;
    saveDialog?: (opts: { defaultPath?: string }) => Promise<string | null>;
  } = {},
): Promise<void> {
  const url = payload.url?.trim();
  if (!url) return;
  const enqueue = deps.enqueue ?? useTransfers.getState().enqueue;
  const pushToast = deps.pushToast ?? ((m: string) => useToasts.getState().push(m, "success"));
  const askWhere = (deps.askWhereToSave ?? getAskWhereToSave)();
  const saveDialog = deps.saveDialog ?? save;

  const defaultFolder = await (deps.dest ?? resolveDest)();
  const suggested = suggestedName(payload);
  const headers = headersForPayload(payload);

  let dest = defaultFolder;
  let name = suggested;

  if (askWhere || payload.prompt) {
    const defaultPath = defaultFolder ? joinPath(defaultFolder, suggested) : suggested;
    const chosen = await saveDialog({ defaultPath });
    if (!chosen) return; // user cancelled — no download
    const split = splitSavePath(chosen);
    dest = split.dir;
    name = split.name;
  }

  const item = itemForUrl(url, name, headers);
  enqueue(accountIdForKind(payload.kind), [item], dest);
  pushToast(`Added from browser: ${item.name}`);
}

/** Join a folder and a leaf with the folder's existing separator (POSIX default). */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep + name;
}

/**
 * Subscribe to the Rust `ingest-url` event and enqueue each capture. Call once
 * on app launch; returns a cleanup that unlistens. Safe when there's no Tauri
 * event runtime (e.g. tests) — it resolves to a no-op cleanup.
 */
export function startIngestListener(): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  listen<IngestPayload>("ingest-url", (ev) => {
    void ingest(ev.payload);
  })
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => {
      /* no Tauri event runtime (e.g. unit tests) */
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
