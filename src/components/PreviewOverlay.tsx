import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, MessageSquarePlus, Download, MoreHorizontal, ExternalLink, FolderOpen, FileArchive, FileQuestion } from "lucide-react";
import { usePreview } from "../store/preview";
import { useApp } from "../store/app";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { useMediaSource } from "../lib/use-media-source";
import { isArchive } from "../lib/review";
import { fileType } from "../lib/file-types";
import { formatBytes } from "../lib/format";
import { pickDownloadDest } from "../lib/ingest";
import { openInFileManager, revealPath, listArchive, extractArchive, type DownloadItem, type ArchiveEntry } from "../lib/tauri/commands";
import { ReviewPlayer } from "./ReviewPlayer";

const NO_COMMENTS: never[] = [];

/**
 * File preview overlay. Single-click a file in the browser opens it here: images,
 * video (direct or JIT-transcoded), audio, and PDF render in-app; archives and
 * other unpreviewable types get an info card. A single actions menu offers Open
 * externally / Reveal (once the file is on disk) and Download. Esc or a backdrop
 * click closes. Mount ONCE near the app root; renders nothing when nothing's open.
 */
export function PreviewOverlay() {
  const current = usePreview((s) => s.current);
  const close = usePreview((s) => s.close);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, close]);

  if (!current) return null;
  return createPortal(<PreviewBody key={`${current.accountId}:${current.target.path}`} />, document.body);
}

/** Join a folder + leaf with the folder's own separator (handles Windows paths). */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep + name;
}

function PreviewBody() {
  const current = usePreview((s) => s.current)!;
  const close = usePreview((s) => s.close);
  const openReview = useApp((s) => s.openReview);
  const { accountId, target } = current;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [noCors, setNoCors] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { url, hlsUrl, isImg, isVideoFile, isAudioFile, isPdfFile, err, setErr, diag, localDest } =
    useMediaSource(accountId, target);

  const ft = fileType(target.name, false);
  const localFile = localDest ? joinPath(localDest, target.name) : null;

  const toReview = () => { close(); openReview(accountId, target); };
  const download = async () => {
    setMenuOpen(false);
    const dest = await pickDownloadDest();
    if (!dest) return;
    const item: DownloadItem = { path: target.path, name: target.name, isDir: false, size: target.size, id: target.fileId };
    useTransfers.getState().enqueue(accountId, [item], dest);
    useToasts.getState().push(`Queued ${target.name}`, "success");
  };
  const openExternal = () => { setMenuOpen(false); if (localFile) void openInFileManager(localFile); };
  const reveal = () => { setMenuOpen(false); if (localFile) void revealPath(localFile); };

  return (
    <div
      className="animate-rise fixed inset-0 z-[120] flex flex-col bg-[#0a0b0d]/95 backdrop-blur-md"
      onClick={close}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 px-4 py-2.5 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white/10">
          <ft.Icon size={18} style={{ color: ft.color }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold leading-tight">{target.name}</div>
          <div className="truncate text-[11px] text-white/45">
            {target.ext ? `${target.ext.toUpperCase()} · ` : ""}{formatBytes(target.size)}{localDest ? " · downloaded" : ""}
          </div>
        </div>

        {isVideoFile && (
          <button onClick={toReview} data-tip="Open reviewer" className="flex items-center gap-1.5 rounded-[9px] bg-white/10 px-3 py-1.5 text-[12.5px] font-semibold hover:bg-white/20">
            <MessageSquarePlus size={14} /> Review
          </button>
        )}

        {/* Actions menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More actions"
            data-tip="Actions"
            className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-white/10 hover:bg-white/20"
          >
            <MoreHorizontal size={17} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-0" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-10 mt-1.5 w-52 overflow-hidden rounded-[11px] border border-white/10 bg-[#17181c] py-1 text-[12.5px] text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
                {localFile && (
                  <>
                    <MenuItem icon={ExternalLink} label="Open in default app" onClick={openExternal} />
                    <MenuItem icon={FolderOpen} label="Reveal in Finder" onClick={reveal} />
                    <div className="my-1 h-px bg-white/10" />
                  </>
                )}
                <MenuItem icon={Download} label={localDest ? "Download again" : "Download"} onClick={() => void download()} />
              </div>
            </>
          )}
        </div>

        <button onClick={close} aria-label="Close preview" data-tip="Close (Esc)" className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-6" onClick={(e) => e.stopPropagation()}>
        {isImg ? (
          err ? <Fallback icon={ft.Icon} title="Couldn’t load the image" body={err} onDownload={download} />
          : url ? (
            <img
              src={url}
              alt={target.name}
              className="animate-fade max-h-full max-w-full rounded-[10px] object-contain shadow-[0_24px_80px_rgba(0,0,0,0.5)]"
              onError={() => setErr("This image format doesn’t decode in-app on this OS. Download it to view.")}
            />
          ) : <Spinner label="Opening…" />
        ) : isAudioFile ? (
          err ? <Fallback icon={ft.Icon} title="Couldn’t play this audio" body={err} onDownload={download} />
          : url ? (
            <div className="animate-fade flex w-full max-w-md flex-col items-center gap-5 rounded-[16px] border border-white/10 bg-white/[0.03] px-8 py-10">
              <span className="flex h-20 w-20 items-center justify-center rounded-[18px] bg-white/8"><ft.Icon size={38} style={{ color: ft.color }} /></span>
              <div className="w-full text-center">
                <div className="truncate text-[14px] font-semibold text-white">{target.name}</div>
                <div className="mt-0.5 text-[11.5px] text-white/45">{formatBytes(target.size)}</div>
              </div>
              <audio src={url} controls autoPlay className="w-full" onError={() => setErr("The player couldn’t decode this audio. Download it to play in your app.")} />
            </div>
          ) : <Spinner label="Opening…" />
        ) : isPdfFile ? (
          err ? <Fallback icon={ft.Icon} title="Couldn’t open the PDF" body={err} onDownload={download} />
          : url ? (
            <embed src={url} type="application/pdf" className="animate-fade h-full w-full max-w-5xl rounded-[10px] bg-white shadow-[0_24px_80px_rgba(0,0,0,0.5)]" />
          ) : <Spinner label="Opening…" />
        ) : isVideoFile ? (
          err ? <Fallback icon={ft.Icon} title="Couldn’t play this file" body={err} onDownload={download} />
          : url ? (
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
                  else setErr(diag || "The player couldn’t decode this file. Download it to review in your editor.");
                }}
              />
            </div>
          ) : <Spinner label="Opening stream…" />
        ) : isArchive(target.name) ? (
          <ArchiveView name={target.name} localFile={localFile} onDownload={download} />
        ) : (
          <Fallback
            icon={FileQuestion}
            title="No in-app preview"
            body={`.${target.ext || target.name.split(".").pop()} can’t be shown in the app (e.g. a RAW still). Download it to open in your editor.`}
            onDownload={download}
          />
        )}
      </div>
    </div>
  );
}

/** Archive preview: lists a local ZIP/RAR's contents and offers one-click extract.
 *  A cloud archive must be downloaded first (can't list without random access). */
function ArchiveView({ name, localFile, onDownload }: { name: string; localFile: string | null; onDownload: () => void }) {
  const [entries, setEntries] = useState<ArchiveEntry[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!localFile) return;
    let alive = true;
    setEntries(null);
    setErr("");
    listArchive(localFile).then((e) => alive && setEntries(e)).catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [localFile]);

  if (!localFile) {
    return <Fallback icon={FileArchive} title="Archive" body="Download it first — then FDM can list and extract it here." onDownload={onDownload} />;
  }

  const extract = async () => {
    setBusy(true);
    try {
      const out = await extractArchive(localFile);
      useToasts.getState().push(`Extracted to “${out.split(/[\\/]/).pop()}”`, "success");
      void revealPath(out);
    } catch (e) {
      useToasts.getState().push(`Extract failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const fileCount = entries?.filter((e) => !e.isDir).length ?? 0;

  return (
    <div className="animate-fade flex h-full max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-white/10 bg-white/[0.03]">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white/8"><FileArchive size={18} className="text-white/80" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-white">{name}</div>
          <div className="text-[11.5px] text-white/45">{entries ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : err ? "Couldn’t read archive" : "Reading…"}</div>
        </div>
        <button onClick={() => void extract()} disabled={busy || !!err} className="flex items-center gap-1.5 rounded-[9px] bg-white/15 px-3.5 py-2 text-[12.5px] font-semibold text-white hover:bg-white/25 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FileArchive size={14} />} {busy ? "Extracting…" : "Extract all"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {err ? (
          <div className="px-4 py-6 text-center text-[12.5px] text-white/50">{err}</div>
        ) : !entries ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-white/50"><Loader2 size={15} className="animate-spin" /> Reading…</div>
        ) : (
          entries.filter((e) => !e.isDir).map((e) => {
            const ft = fileType(e.name.split("/").pop() || e.name, false);
            return (
              <div key={e.name} className="flex items-center gap-2.5 border-b border-white/5 px-4 py-2 text-[12px]">
                <ft.Icon size={15} style={{ color: ft.color }} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-white/85" title={e.name}>{e.name}</span>
                <span className="tnum shrink-0 text-[11px] text-white/40">{formatBytes(e.size)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick }: { icon: typeof Download; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-white/10">
      <Icon size={14} className="text-white/70" /> {label}
    </button>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-white/70">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

function Fallback({ icon: Icon, title, body, onDownload }: { icon: typeof Download; title: string; body: string; onDownload: () => void }) {
  return (
    <div className="flex max-w-md flex-col items-center gap-3 rounded-[16px] border border-white/10 bg-white/[0.03] px-10 py-12 text-center text-white">
      <span className="flex h-16 w-16 items-center justify-center rounded-[16px] bg-white/8"><Icon size={30} className="text-white/70" /></span>
      <div className="text-[15px] font-semibold">{title}</div>
      <div className="text-[13px] leading-relaxed text-white/55">{body}</div>
      <button onClick={onDownload} className="mt-2 flex items-center gap-1.5 rounded-[9px] bg-white/15 px-4 py-2 text-[13px] font-semibold hover:bg-white/25">
        <Download size={14} /> Download
      </button>
    </div>
  );
}
