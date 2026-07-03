import { useEffect, useMemo, useState } from "react";
import type { ReviewTarget } from "../store/app";
import { useHistory } from "../store/history";
import { streamMode } from "./tauri/commands";
import { hlsMasterUrl, isImage, isPlayable, isVideo, sourceParams, streamUrl } from "./review";

/**
 * Above this size, even a playable-codec video is streamed via the transcoded
 * HLS proxy rather than direct-played: raw footage runs 100+ Mbps, which can't
 * sustain real-time playback pulled whole from the cloud, so the low-bitrate
 * proxy is what makes it watchable (same idea as Drive/Dropbox web preview).
 */
const LARGE_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export interface MediaSource {
  /** Direct loopback `/media` URL — the <img src> / direct-play <video src>. */
  url: string | null;
  /** HLS master-playlist URL when the clip needs JIT transcoding, else null. */
  hlsUrl: string | null;
  /** True for still images (rendered via <img>). */
  isImg: boolean;
  /** True for any recognized video (playable or transcode-needed). */
  isVideoFile: boolean;
  /** True for anything we can show in-app at all (video or image). */
  previewable: boolean;
  /** A background-probe error string to surface only if playback also fails. */
  diag: string;
  /** Hard error resolving the source. */
  err: string;
  setErr: (s: string) => void;
  /** The local copy's folder if this exact file was already downloaded. */
  localDest: string | undefined;
}

/**
 * Resolve how to play/show a review target, shared by the full reviewer and the
 * lightweight preview overlay so both behave identically.
 *
 * Matches how Drive/Dropbox web preview a clip:
 *   • already-playable (H.264/AAC → the PLAYABLE ext set) streams DIRECT over
 *     HTTP range requests — instant, no transcode.
 *   • anything else recognized as video (ProRes/MXF/R3D/HEVC…) goes through the
 *     JIT HLS transcoder (`stream_mode` probes the real codec server-side and
 *     returns "hls"; ffmpeg transcodes ~6s segments on demand).
 *   • still images render via a plain <img>; RAW stills stay unpreviewable.
 *
 * When the exact file is already downloaded (a completed history job for this
 * account+path), its destination folder is passed through so the backend serves
 * straight from local disk — instant and offline.
 */
export function useMediaSource(accountId: string, target: ReviewTarget): MediaSource {
  const isImg = isImage(target.name);
  const isVideoFile = isVideo(target.name);
  const playable = isPlayable(target.name);
  const previewable = isImg || isVideoFile;

  const historyItems = useHistory((s) => s.items);
  const localDest = useMemo(
    () => historyItems.find((h) => h.status === "success" && h.accountId === accountId && h.item?.path === target.path)?.dest,
    [historyItems, accountId, target.path],
  );

  const [url, setUrl] = useState<string | null>(null);
  const [hlsUrl, setHlsUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [diag, setDiag] = useState("");

  useEffect(() => {
    if (!previewable) return;
    let alive = true;
    setUrl(null);
    setHlsUrl(null);
    setErr("");
    setDiag("");

    (async () => {
      try {
        const direct = await streamUrl(accountId, target, localDest);
        if (!alive) return;
        setUrl(direct);
        if (isImg) return; // <img onError> handles failures; no probing needed.

        // Decide direct vs transcoded (HLS), matching how Drive/Dropbox web
        // preview a clip:
        //  • a pro codec (not directly playable) → transcode so it plays at all;
        //  • a HUGE clip, even in a playable codec → transcode too, because
        //    streaming the full-bitrate original (raw footage runs 100+ Mbps)
        //    can't sustain real-time playback over the cloud — the low-bitrate
        //    HLS proxy is what makes it watchable. Small playable clips stay on
        //    the instant direct path.
        const localCopy = !!localDest; // already on disk → direct is instant, skip transcode
        const huge = target.size > LARGE_VIDEO_BYTES;
        if (!localCopy && (!playable || huge)) {
          // For a playable-but-huge clip we already know we want HLS; only a
          // maybe-unplayable codec needs the server probe to confirm.
          const mode = playable ? "hls" : await streamMode(sourceParams(accountId, target, localDest)).catch(() => "hls" as const);
          if (!alive) return;
          if (mode === "hls") {
            const master = await hlsMasterUrl(accountId, target);
            if (alive) setHlsUrl(master);
          }
        }

        // Background-probe the direct URL only to capture a real error message we
        // can surface IF playback fails; never block playback on it.
        fetch(direct)
          .then(async (res) => {
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              if (alive) setDiag(`Stream error ${res.status}${body ? `, ${body.slice(0, 300)}` : ""}`);
            } else {
              res.body?.cancel?.();
            }
          })
          .catch(() => {
            /* probe blocked (e.g. fetch CORS), ignore; the video may still play */
          });
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      alive = false;
    };
  }, [accountId, target, previewable, isImg, playable, localDest]);

  return { url, hlsUrl, isImg, isVideoFile, previewable, diag, err, setErr, localDest };
}
