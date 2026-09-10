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
const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/**
 * File preview — opens like a document window inside the app (theme surface, not a
 * dark cinematic overlay): images, video, audio, and PDF render in-app; archives
 * list their contents with one-click extract; other types get an info card. Its
 * title bar clears the macOS traffic lights and is draggable. Esc or the backdrop
 * edge closes. Mount ONCE near the app root; renders nothing when nothing's open.
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
    <div className="animate-rise fixed inset-0 z-[120] flex flex-col bg-[var(--surface)]" onClick={close}>
      {/* Title bar — draggable, and inset past the macOS traffic lights. */}
      <div
        data-tauri-drag-region
        className={`flex h-14 shrink-0 select-none items-center gap-3 border-b border-[var(--line)] bg-[var(--card)] pr-3 ${isMac ? "pl-[104px]" : "pl-4"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--soft)]">
          <ft.Icon size={17} style={{ color: ft.color }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-[var(--ink)]">{target.name}</div>
          <div className="truncate text-[11px] text-[var(--faint)]">
            {target.ext ? `${target.ext.toUpperCase()} · ` : ""}{formatBytes(target.size)}{localDest ? " · downloaded" : ""}
          </div>
        </div>

        {isVideoFile && (
          <button onClick={toReview} data-tip="Open reviewer" className="flex items-center gap-1.5 rounded-[9px] border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--mut)] hover:border-[var(--line2)] hover:text-[var(--ink)]">
            <MessageSquarePlus size={14} /> Review
          </button>
        )}

        {/* Actions menu */}
        <div className="relative">
          <button onClick={() => setMenuOpen((v) => !v)} aria-label="More actions" data-tip="Actions" className="flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
            <MoreHorizontal size={17} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-0" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-10 mt-1.5 w-52 overflow-hidden rounded-[11px] border border-[var(--line)] bg-[var(--card)] py-1 text-[12.5px] text-[var(--ink)] shadow-[var(--shadow-lg)]">
                {localFile && (
                  <>
                    <MenuItem icon={ExternalLink} label="Open in default app" onClick={openExternal} />
                    <MenuItem icon={FolderOpen} label="Reveal in Finder" onClick={reveal} />
                    <div className="my-1 h-px bg-[var(--line)]" />
                  </>
                )}
                <MenuItem icon={Download} label={localDest ? "Download again" : "Download"} onClick={() => void download()} />
              </div>
            </>
          )}
        </div>

        <button onClick={close} aria-label="Close preview" data-tip="Close (Esc)" className="flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
          <X size={17} />
        </button>
      </div>

      {/* Body — a neutral document canvas. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--bg)] p-6" onClick={(e) => e.stopPropagation()}>
        {isImg ? (
          err ? <Fallback icon={ft.Icon} title="Couldn’t load the image" body={err} onDownload={download} />
          : url ? (
            <img
              src={url}
              alt={target.name}
              className="animate-fade max-h-full max-w-full rounded-[8px] object-contain shadow-[var(--shadow)]"
              onError={() => setErr("This image format doesn’t decode in-app on this OS. Download it to view.")}
            />
          ) : <Spinner label="Opening…" />
        ) : isAudioFile ? (
          err ? <Fallback icon={ft.Icon} title="Couldn’t play this audio" body={err} onDownload={download} />
          : url ? (
            <div className="animate-fade flex w-full max-w-md flex-col items-center gap-5 rounded-[16px] border border-[var(--line)] bg-[var(--card)] px-8 py-10">
              <span className="flex h-20 w-20 items-center justify-center rounded-[18px] bg-[var(--soft)]"><ft.Icon size={38} style={{ color: ft.color }} /></span>
              <div className="w-full text-center">
                <div className="truncate text-[14px] font-semibold text-[var(--ink)]">{target.name}</div>
                <div className="mt-0.5 text-[11.5px] text-[var(--faint)]">{formatBytes(target.size)}</div>
              </div>
              <audio src={url} controls autoPlay className="w-full" onError={() => setErr("The player couldn’t decode this audio. Download it to play in your app.")} />
            </div>
          ) : <Spinner label="Opening…" />
        ) : isPdfFile ? (
          err ? <Fallback icon={ft.Icon} title="Couldn’t open the PDF" body={err} onDownload={download} />
          : url ? (
            <embed src={url} type="application/pdf" className="animate-fade h-full w-full rounded-[8px] bg-white shadow-[var(--shadow)]" />
          ) : <Spinner label="Opening…" />
        ) : isVideoFile ? (
          err ? <Fallback icon={ft.Icon} title="Couldn’t play this file" body={err} onDownload={download} />
          : url ? (
            <div className="relative flex h-full max-h-full w-full max-w-5xl items-center justify-center overflow-hidden rounded-[10px] bg-black shadow-[var(--shadow)]">
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
    <div className="animate-fade flex h-full max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow)]">
      <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--soft)]"><FileArchive size={18} className="text-[var(--mut)]" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-[var(--ink)]">{name}</div>
          <div className="text-[11.5px] text-[var(--faint)]">{entries ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : err ? "Couldn’t read archive" : "Reading…"}</div>
        </div>
        <button onClick={() => void extract()} disabled={busy || !!err} className="flex items-center gap-1.5 rounded-[9px] border border-[var(--acc)] bg-[var(--acc)] px-3.5 py-2 text-[12.5px] font-semibold text-[var(--onacc)] hover:opacity-90 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FileArchive size={14} />} {busy ? "Extracting…" : "Extract all"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {err ? (
          <div className="px-4 py-6 text-center text-[12.5px] text-[var(--faint)]">{err}</div>
        ) : !entries ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-[var(--faint)]"><Loader2 size={15} className="animate-spin" /> Reading…</div>
        ) : (
          entries.filter((e) => !e.isDir).map((e) => {
            const eft = fileType(e.name.split("/").pop() || e.name, false);
            return (
              <div key={e.name} className="flex items-center gap-2.5 border-b border-[var(--line)] px-4 py-2 text-[12px]">
                <eft.Icon size={15} style={{ color: eft.color }} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[var(--ink)]" title={e.name}>{e.name}</span>
                <span className="tnum shrink-0 text-[11px] text-[var(--faint)]">{formatBytes(e.size)}</span>
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
    <button onClick={onClick} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--soft)]">
      <Icon size={14} className="text-[var(--mut)]" /> {label}
    </button>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--mut)]">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

function Fallback({ icon: Icon, title, body, onDownload }: { icon: typeof Download; title: string; body: string; onDownload: () => void }) {
  return (
    <div className="flex max-w-md flex-col items-center gap-3 rounded-[16px] border border-[var(--line)] bg-[var(--card)] px-10 py-12 text-center text-[var(--ink)] shadow-[var(--shadow)]">
      <span className="flex h-16 w-16 items-center justify-center rounded-[16px] bg-[var(--soft)]"><Icon size={30} className="text-[var(--mut)]" /></span>
      <div className="text-[15px] font-semibold">{title}</div>
      <div className="text-[13px] leading-relaxed text-[var(--faint)]">{body}</div>
      <button onClick={onDownload} className="mt-2 flex items-center gap-1.5 rounded-[9px] border border-[var(--acc)] bg-[var(--acc)] px-4 py-2 text-[13px] font-semibold text-[var(--onacc)] hover:opacity-90">
        <Download size={14} /> Download
      </button>
    </div>
  );
}
