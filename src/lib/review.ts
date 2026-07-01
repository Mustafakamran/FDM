import { streamBase } from "./tauri/commands";
import type { ReviewTarget } from "../store/app";

/** Codecs the webview <video> can decode → reviewable in-app. */
const PLAYABLE = new Set(["mp4", "m4v", "mov", "webm", "ogv", "ogg"]);
/** Anything we recognize as video (playable or not) → gets a Review affordance. */
const VIDEO = new Set([
  ...PLAYABLE,
  "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "mts", "m2ts", "ts",
  "mxf", "r3d", "braw", "ari", "dnxhd", "dnxhr", "prores",
]);
/**
 * Formats every webview reliably decodes via a plain <img> tag. RAW formats
 * (ARW/CR2/NEF/DNG…) are deliberately excluded — no browser/webview decodes
 * them natively, and there's no bundled decoder for them in this app, so
 * they fall through to the same "download to view" message pro video codecs
 * already get, rather than a silently broken image.
 */
const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
/**
 * HEIC/HEIF decode natively on macOS (WKWebView/Safari engine) but generally
 * NOT on Windows (WebView2/Chromium doesn't support it as of writing) — kept
 * separate from IMAGE so the UI can attempt it but degrade gracefully
 * (onError) rather than assume it always works.
 */
const IMAGE_BEST_EFFORT = new Set(["heic", "heif"]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
export function isVideo(name: string): boolean {
  return VIDEO.has(extOf(name));
}
export function isPlayable(name: string): boolean {
  return PLAYABLE.has(extOf(name));
}
export function isImage(name: string): boolean {
  const ext = extOf(name);
  return IMAGE.has(ext) || IMAGE_BEST_EFFORT.has(ext);
}
/** Anything that gets an in-app preview affordance at all (video or image). */
export function isPreviewable(name: string): boolean {
  return isVideo(name) || isImage(name);
}

/** UTF-8-safe base64url (no padding) — matches the Rust URL_SAFE_NO_PAD decoder. */
function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The cloud-source query params shared by the direct `/media` URL and the HLS
 * `master.m3u8` URL. Both endpoints parse this exact string by raw split, so all
 * values must already be URL-safe (path is base64url; ids/ext/acct alphanumeric).
 * `localDest` is optional: the destination folder this exact item was already
 * downloaded to (a completed job matched in history), if any — lets the
 * backend serve straight from disk instead of the cloud (instant, offline).
 */
export function sourceParams(accountId: string, t: ReviewTarget, localDest?: string): string {
  const dest = localDest ? `&dest=${b64url(localDest)}` : "";
  return `acct=${accountId}&path=${b64url(t.path)}&fid=${t.fileId ?? ""}&size=${t.size}&ext=${t.ext}${dest}`;
}

/**
 * Loopback streaming-proxy URL for a video/image — the direct, non-transcoded
 * path. Also the input ffmpeg pulls bytes through when transcoding HLS
 * segments. Serves from local disk when `localDest` resolves to an
 * already-downloaded copy; falls back to the cloud otherwise.
 */
export async function streamUrl(accountId: string, t: ReviewTarget, localDest?: string): Promise<string> {
  const base = await streamBase();
  return `${base}/media?${sourceParams(accountId, t, localDest)}`;
}

/**
 * HLS master-playlist URL for a video — the adaptive-bitrate path. Same source
 * params as {@link streamUrl}; only the route differs (`/hls/master.m3u8`). The
 * backend serves the per-rendition media playlists and JIT-transcoded segments.
 */
export async function hlsMasterUrl(accountId: string, t: ReviewTarget): Promise<string> {
  const base = await streamBase();
  return `${base}/hls/master.m3u8?${sourceParams(accountId, t)}`;
}

/** Seconds → "m:ss" or "h:mm:ss". */
export function timecode(secInput: number): string {
  const sec = Number.isFinite(secInput) && secInput > 0 ? secInput : 0;
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
}
