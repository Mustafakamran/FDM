import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../store/settings";

/**
 * "Transfer complete" feedback: a desktop notification + a short chime, each
 * gated by its own setting. Both are best-effort - a failed notification or a
 * blocked AudioContext must never throw into the poll loop.
 *
 * The desktop notification is posted from RUST (`notify_desktop`), not the
 * webview plugin: on macOS the webview plugin silently drops notifications from
 * the unsigned `tauri dev` binary, whereas the Rust side uses `osascript` which
 * works in dev too (and the native plugin on Windows/Linux).
 */

/** A soft two-note chime via Web Audio - no bundled asset, no autoplay file. */
function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    // A5 → E6, a gentle rising ping.
    for (const [freq, t] of [[880, 0], [1318.5, 0.11]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, now + t);
      gain.gain.exponentialRampToValueAtTime(0.16, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.38);
      osc.start(now + t);
      osc.stop(now + t + 0.42);
    }
    setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch {
    /* AudioContext unavailable / blocked - ignore. */
  }
}

/** Kind of transfer, for the notification title. */
export type CompleteKind = "download" | "upload";

/**
 * Announce a finished transfer: desktop notification (if enabled + permitted)
 * and a chime (if enabled). Call once per completed job.
 */
export function notifyTransferComplete(name: string, kind: CompleteKind): void {
  const { notifyOnComplete, completionSound } = useSettings.getState();
  if (completionSound) playChime();
  if (!notifyOnComplete) return;
  void invoke("notify_desktop", {
    title: kind === "upload" ? "Upload complete" : "Download complete",
    body: name,
  }).catch(() => {
    /* not in a Tauri webview (tests) / notification unavailable - ignore */
  });
}
