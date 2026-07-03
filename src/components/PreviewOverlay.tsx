import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, MessageSquarePlus, Download } from "lucide-react";
import { usePreview } from "../store/preview";
import { useApp } from "../store/app";
import { useMediaSource } from "../lib/use-media-source";
import { ReviewPlayer } from "./ReviewPlayer";

const NO_COMMENTS: never[] = [];

/**
 * Lightweight preview overlay. Single-click on a video/image opens this modal —
 * image shown large, video played inline (direct or JIT-transcoded, exactly like
 * the reviewer, just without comments/timecode/export). Esc or a click on the
 * backdrop closes it. "Review" hands off to the full reviewer for the same file.
 *
 * Mount ONCE near the app root. Renders nothing when no file is open.
 */
export function PreviewOverlay() {
  const current = usePreview((s) => s.current);
  const close = usePreview((s) => s.close);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, close]);

  if (!current) return null;
  return createPortal(<PreviewBody key={`${current.accountId}:${current.target.path}`} />, document.body);
}

function PreviewBody() {
  const current = usePreview((s) => s.current)!;
  const close = usePreview((s) => s.close);
  const openReview = useApp((s) => s.openReview);
  const { accountId, target } = current;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [noCors, setNoCors] = useState(false);
  const { url, hlsUrl, isImg, isVideoFile, err, setErr, diag } = useMediaSource(accountId, target);

  const toReview = () => {
    close();
    openReview(accountId, target);
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex flex-col bg-black/80 backdrop-blur-sm animate-rise"
      onClick={close}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 px-5 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{target.name}</span>
        {isVideoFile && (
          <button
            onClick={toReview}
            data-tip="Open in the full reviewer (comments, timecode, export)"
            className="flex items-center gap-1.5 rounded-[8px] bg-white/10 px-3 py-1.5 text-[12.5px] font-semibold hover:bg-white/20"
          >
            <MessageSquarePlus size={14} /> Review
          </button>
        )}
        <button
          onClick={close}
          aria-label="Close preview"
          data-tip="Close (Esc)"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-6" onClick={(e) => e.stopPropagation()}>
        {isImg ? (
          err ? (
            <Fallback title="Couldn’t load the image" body={err} />
          ) : url ? (
            <img
              src={url}
              alt={target.name}
              className="max-h-full max-w-full rounded-[8px] object-contain"
              onError={() =>
                setErr(
                  "This image format doesn’t decode in the app on this OS (HEIC previews on macOS but generally not on Windows). Download it to view.",
                )
              }
            />
          ) : (
            <Spinner label="Opening…" />
          )
        ) : !isVideoFile ? (
          <Fallback
            title="Can’t preview this format in-app"
            body={`.${target.name.split(".").pop()} can’t be shown in the app (e.g. a RAW still). Download it to view in your editor.`}
          />
        ) : err ? (
          <Fallback title="Couldn’t play this file" body={err} />
        ) : url ? (
          <div className="relative flex h-full max-h-full w-full max-w-5xl items-center justify-center">
            <ReviewPlayer
              videoRef={videoRef}
              src={url}
              hlsSrc={hlsUrl}
              noCors={noCors}
              comments={NO_COMMENTS}
              duration={0}
              onDuration={() => {}}
              onTime={() => {}}
              onError={() => {
                if (!noCors) setNoCors(true);
                else
                  setErr(
                    diag ||
                      "The player couldn’t decode this file. Download it to review in your editor.",
                  );
              }}
            />
          </div>
        ) : (
          <Spinner label="Opening stream…" />
        )}
      </div>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-white/70">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

function Fallback({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex max-w-md flex-col items-center gap-2 rounded-[12px] bg-white/5 px-8 py-10 text-center text-white">
      <Download size={22} className="text-white/60" />
      <div className="text-[15px] font-semibold">{title}</div>
      <div className="text-[13px] text-white/60">{body}</div>
    </div>
  );
}
