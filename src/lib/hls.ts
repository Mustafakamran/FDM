/**
 * Pure helpers for the review player's HLS / ABR layer. Kept free of React and
 * hls.js so they can be unit-tested in isolation. The component wires these to a
 * real `Hls` instance and the `<video>` element.
 */

/** How the player will attach a video source. */
export type PlaybackMode = "hls" | "native" | "direct";

/** The browser/webview capabilities the playback decision depends on. */
export interface PlayerCapabilities {
  /** `Hls.isSupported()` — MSE-based playback (gives ABR + a quality menu). */
  hlsSupported: boolean;
  /** `video.canPlayType("application/vnd.apple.mpegurl")` is non-empty (native HLS). */
  nativeHls: boolean;
}

/**
 * Decide how to attach playback for a video:
 * - `"hls"`    — hls.js drives MSE; gives ABR + the quality menu (preferred).
 * - `"native"` — the webview plays HLS natively (Safari/WKWebView); ABR is automatic.
 * - `"direct"` — no HLS support; fall back to the direct `/media` proxy URL.
 *
 * hls.js is preferred over native when both are available because only it exposes
 * the manual level menu this UI needs.
 */
export function playbackMode(caps: PlayerCapabilities): PlaybackMode {
  if (caps.hlsSupported) return "hls";
  if (caps.nativeHls) return "native";
  return "direct";
}

/** A selectable quality level: `-1` is Auto (ABR), otherwise an hls.js level index. */
export interface QualityOption {
  /** hls.js level index, or `-1` for Auto. */
  level: number;
  label: string;
}

/** The Auto sentinel for `hls.currentLevel` (lets ABR choose). */
export const AUTO_LEVEL = -1;

/** Renditions at/below this height count as a "cheap" first-paint start level. */
const CHEAP_START_MAX_HEIGHT = 720;

/**
 * Pick a CONSERVATIVE start level (hls.js level index) for first paint behind a
 * just-in-time transcode backend: the HIGHEST rendition at/below 720p, so
 * playback begins from a cheap segment the transcoder can produce fast — never
 * the top (e.g. 1080p) rendition. Falls back to the overall lowest rendition
 * when every level is above the cheap cap, and to `0` when heights are unknown.
 * ABR is re-enabled immediately after, so quality still ramps up.
 *
 * Returns an index into the passed `levels` array (hls.js's own level order).
 */
export function conservativeStartLevel(levels: { height: number }[]): number {
  if (levels.length === 0) return 0;
  let cheapIdx = -1;
  let cheapHeight = -1;
  let lowestIdx = 0;
  let lowestHeight = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const h = levels[i].height;
    if (h <= CHEAP_START_MAX_HEIGHT && h > cheapHeight) {
      cheapHeight = h;
      cheapIdx = i;
    }
    if (h < lowestHeight) {
      lowestHeight = h;
      lowestIdx = i;
    }
  }
  return cheapIdx >= 0 ? cheapIdx : lowestIdx;
}

/** Map an hls.js level height to a menu label (e.g. 1080 → "1080p"). */
export function levelLabel(height: number): string {
  return height > 0 ? `${height}p` : "Auto";
}

/**
 * Build the quality menu from hls.js levels: a leading "Auto" entry plus one
 * entry per level, highest resolution first. Levels are matched back to hls.js by
 * their original index, so the input order (as hls.js reports it) is preserved in
 * each option's `level` while the menu itself is sorted for display.
 */
export function qualityOptions(levels: { height: number }[]): QualityOption[] {
  const opts = levels.map((l, i) => ({ level: i, label: levelLabel(l.height), height: l.height }));
  opts.sort((a, b) => b.height - a.height);
  return [
    { level: AUTO_LEVEL, label: "Auto" },
    ...opts.map(({ level, label }) => ({ level, label })),
  ];
}

/**
 * The label shown on the quality control. Auto annotates the level ABR currently
 * picked (e.g. "Auto 720p") when known; a manual pick shows just its label.
 */
export function activeQualityLabel(
  current: number,
  loadingLevel: number,
  levels: { height: number }[],
): string {
  if (current === AUTO_LEVEL) {
    const lvl = levels[loadingLevel];
    return lvl ? `Auto ${levelLabel(lvl.height)}` : "Auto";
  }
  const lvl = levels[current];
  return lvl ? levelLabel(lvl.height) : "Auto";
}
