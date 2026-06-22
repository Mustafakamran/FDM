# Review Player — Adaptive Bitrate (ABR) Streaming — Design

**Date:** 2026-06-22
**Status:** Approved (design); proceeding to implementation per user directive.
**Scope:** Make the in-app review player stream cloud (and local) footage smoothly at
selectable quality (1080/720/480 + Auto) instead of playing the full-res original and
stalling. Just-in-time HLS transcoding via a bundled ffmpeg, played by hls.js.

## Goal

Reviewing large/high-bitrate footage stalls today because the `<video>` element streams
the original file at full resolution/bitrate through the loopback proxy. We want
**YouTube-style ABR**: the player adapts to available bandwidth and the user can pick
**1080p / 720p / 480p / Auto**, so playback starts fast, never buffers, and scrubbing to
comment timestamps stays responsive — without downloading the whole file.

## Approach — just-in-time HLS

The existing loopback proxy (`stream.rs`) already turns an authenticated cloud file into a
**seekable HTTP source**. We add an HLS layer that transcodes on demand:

```
ReviewPlayer (hls.js)
  GET /{secret}/hls/master.m3u8?<src>        → variant playlist: 1080 / 720 / 480 (≤ source height)
  GET /{secret}/hls/media-<rend>.m3u8?<src>  → VOD media playlist (segment list from probed duration)
  GET /{secret}/hls/seg-<rend>-<n>.ts?<src>  → ffmpeg transcodes ONLY segment n (a ~6s window),
                                                reading the source via the existing /media proxy URL
```

- **hls.js** in the webview performs ABR automatically (**Auto**) and exposes a manual
  **1080/720/480** menu (caps the level).
- **Independent per-segment transcode** → each `.ts` is a self-contained, keyframe-initial
  GOP transcoded from its own timestamp. Seeking/scrubbing to any point just transcodes
  that segment — no full-file pass, no sequential dependency.
- **VOD playlist** (full duration known from `ffprobe`) → hls.js shows the full timeline and
  can seek anywhere immediately.

### Source abstraction

The segment transcoder's ffmpeg input is either:
- **Cloud:** the loopback `/{secret}/media?acct=&fid=&path=&size=` URL — ffmpeg pulls bytes
  through our authenticated, range-capable proxy (no creds in ffmpeg).
- **Local:** a filesystem path (downloaded footage) — used directly as `-i`.

A `Source` is identified by a stable key (cloud: `acct|path`; local: absolute path) used for
caching probe results and segments.

## Renditions

| Name  | Height | Video (H.264) | Audio (AAC) | Notes |
|-------|--------|---------------|-------------|-------|
| 1080p | 1080   | ~5.0 Mbps     | 128 kbps    | High profile |
| 720p  | 720    | ~2.8 Mbps     | 128 kbps    | Main profile |
| 480p  | 480    | ~1.4 Mbps     | 96 kbps     | Main profile |

- `scale=-2:<h>` preserves aspect ratio (even width). **Never upscale**: only renditions with
  height ≤ source height are offered; always offer at least the lowest. Source height comes
  from `ffprobe`.
- 6-second segments. Each segment encodes with a forced IDR at its start so it is
  independently decodable. `-output_ts_offset` keeps segment timing aligned to the playlist.

## Hardware acceleration (best-effort, software fallback)

At startup, probe the bundled ffmpeg's encoders once (cache the result) and pick the best
available H.264 encoder; **always fall back to `libx264 -preset veryfast` if hardware fails**:
- **macOS:** `h264_videotoolbox` (+ `-hwaccel videotoolbox` decode).
- **Windows:** try `h264_nvenc` → `h264_qsv` → `h264_amf` → `libx264`.

Hardware selection must degrade gracefully: if a segment transcode fails on the hw encoder,
retry that segment with `libx264` and remember to use software thereafter for that session.

## Components

### Build plumbing (owned by the main implementer, not the agents)
- **`scripts/fetch-ffmpeg.mjs`** — mirrors `fetch-rclone.mjs`: downloads static ffmpeg +
  ffprobe builds per platform into `src-tauri/binaries/` named for the Tauri target triple
  (`ffmpeg-<triple>`, `ffprobe-<triple>`). Uses `copyFileSync` (Windows EXDEV-safe).
- **`tauri.conf.json`** — add `ffmpeg`/`ffprobe` to `bundle.externalBin` (sidecars).
- **`package.json`** — add `hls.js`; add `fetch:ffmpeg` and wire it into the build/predev.
- **CI (`.github/workflows/build.yml`)** — run `fetch:ffmpeg` and cache the binaries.

### Backend — `src-tauri/src/hls.rs` (new)
- Routes served by the existing `stream.rs` server (new `/{secret}/hls/...` paths):
  `master.m3u8`, `media-<rend>.m3u8`, `seg-<rend>-<n>.ts`.
- **Pure, unit-tested seams:**
  - `master_playlist(renditions) -> String` — `#EXT-X-STREAM-INF` per rendition.
  - `media_playlist(duration, seg_dur, rendition) -> String` — `EXTINF` list + `#EXT-X-ENDLIST`,
    correct final-segment remainder, `#EXT-X-PLAYLIST-TYPE:VOD`.
  - `segment_window(n, seg_dur, duration) -> (start, dur)`.
  - `ffmpeg_args(input, start, dur, rendition, encoder) -> Vec<String>` — the JIT transcode
    command (seek, scale, encoder, mpegts to stdout, ts offset).
  - `pick_encoder(available, os) -> Encoder`.
- **Runtime:** ffprobe the source once (cache duration + source height keyed by Source);
  spawn the ffmpeg sidecar per segment to stdout; cache the produced `.ts` to a temp dir
  (LRU-capped, cleared on exit); a **semaphore caps concurrent ffmpeg processes** (default 3);
  **prefetch** the next 1 segment after serving one.
- Locate ffmpeg/ffprobe via the Tauri shell sidecar API (same mechanism as the rclone sidecar).

### Backend — `src-tauri/src/stream.rs` (modified)
- Dispatch `/hls/...` requests to `hls.rs`; keep the existing `/media` path unchanged (it is
  both the legacy player path and the cloud input for ffmpeg).
- `lib.rs` registers the new `hls` module.

### Frontend — `src/components/ReviewPlayer.tsx` (modified) + `hls.js`
- For a video file: attach **hls.js** to the `<video>`, load `master.m3u8`.
- **Quality menu:** Auto (default ABR) + 1080/720/480, wired to hls.js levels (manual selection
  caps `hls.currentLevel`).
- All existing review features unchanged: comment markers, frame-step, speed, fullscreen,
  timestamp auto-capture, keyboard shortcuts.
- **Fallback chain:**
  1. **Source-passthrough:** if the file is already web-native and ≤1080p H.264 mp4, play it
     directly via the existing `/media` proxy (no transcode).
  2. **HLS ABR** for everything else (the main path).
  3. If HLS/ffmpeg is unavailable, fall back to today's direct `/media` `<video>` so review
     never hard-breaks.

## Data flow

```
open clip → ffprobe(source) [cached] → duration + height
  → hls.js loads master.m3u8 → picks a level (ABR or user choice)
  → requests media-<rend>.m3u8 → segment list
  → requests seg-<rend>-<n>.ts → ffmpeg JIT transcodes window n [cached] → mpegts
  → hls.js buffers/plays; prefetch n+1; user scrubs → request that segment
```

## Error handling

- Segment transcode failure on a hw encoder → retry once with `libx264`; persist software
  choice for the session. Repeated failure → 500 for that segment; hls.js retries/falls to a
  lower level; if the whole HLS path fails, the player falls back to direct `/media`.
- ffprobe failure (unknown duration) → fall back to direct play.
- Cache writes are best-effort; a cache miss just re-transcodes.

## Caching & lifecycle

- Temp dir under the app cache (e.g. `<cache>/hls/<source-hash>/`). Segment files keyed by
  `<rend>-<n>.ts`. LRU eviction with a total size cap (e.g. 2 GB). Probe results cached in
  memory keyed by Source. Best-effort cleanup of the HLS temp dir on app exit.

## Testing

- **Rust unit (pure seams):** master/media playlist text for a given duration (segment count,
  EXTINF values, remainder segment, ENDLIST), `segment_window` math, `ffmpeg_args` for each
  rendition + encoder, `pick_encoder` per OS/available-set. No ffmpeg needed in CI.
- **Frontend unit:** quality-level mapping (Auto/1080/720/480 → hls level), fallback decision
  (passthrough vs HLS vs direct) as a pure helper.
- **Manual E2E (local, ffmpeg present):** play a cloud clip, switch qualities, scrub to a
  timestamp, confirm smooth start + no full-file download (observe network/segment requests).

## Out of scope (future)

- Storyboard/thumbnail scrub previews.
- Subtitle/multi-audio tracks.
- Pre-generating proxies at download time (could later make local review instant).
- Persisting the HLS cache across sessions.

## Known boundaries / mitigations

- **JIT first-segment latency:** spawning ffmpeg per segment costs ~hundreds ms–~1s on first
  hit; mitigated by prefetch + cache + hls.js look-ahead buffering.
- **MP4 `moov`-at-end over cloud:** ffmpeg re-reads the index per spawn → extra range fetches.
  Acceptable; cached after first play. Local sources have no such cost. (Future: faststart
  remux cache.)
- **Exotic codecs (MXF/ProRes/RAW):** ffmpeg decodes them; heavier CPU but works, and is the
  whole point — these are exactly the files the webview can't play natively today.
- CPU load is bounded by the ffmpeg-process semaphore.
