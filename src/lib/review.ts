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
 */
export function sourceParams(accountId: string, t: ReviewTarget): string {
  return `acct=${accountId}&path=${b64url(t.path)}&fid=${t.fileId ?? ""}&size=${t.size}&ext=${t.ext}`;
}

/**
 * Loopback streaming-proxy URL for a video — the direct, non-transcoded path.
 * Also the input ffmpeg pulls bytes through when transcoding HLS segments.
 */
export async function streamUrl(accountId: string, t: ReviewTarget): Promise<string> {
  const base = await streamBase();
  return `${base}/media?${sourceParams(accountId, t)}`;
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
