import { useEffect, useRef, useState } from "react";
import { Globe, Folder, Plus, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { Button } from "./ui";
import { FOLDER_KEY, pickDownloadDest } from "../lib/ingest";
import { saveRaw } from "../lib/persisted";

/**
 * "Add web download" — a compact button that opens a dropdown with the URL input,
 * a destination-folder picker, and Download. (Replaces the always-open box so the
 * Web Downloads screen leads with the list, not a form.) Exercises the SECONDARY
 * scheduling lane (account id "http") so it never disturbs primary Drive/Dropbox.
 */
export function UrlDownload() {
  const enqueueUrl = useTransfers((s) => s.enqueueUrl);
  const enqueueTorrentFile = useTransfers((s) => s.enqueueTorrentFile);
  const toast = useToasts((s) => s.push);
  const [url, setUrl] = useState("");
  const [open_, setOpen] = useState(false);
  // Frame.io shares expose both a full-res master and proxy renditions; the user
  // picks which to pull. Ignored for every other link type.
  const [mode, setMode] = useState<"original" | "proxy">("original");
  const [proxyRes, setProxyRes] = useState<"highest" | "1080" | "720" | "smallest">("highest");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isFrameio = (() => {
    try {
      const h = new URL(url.trim()).hostname.toLowerCase();
      return h === "frame.io" || h.endsWith(".frame.io") || h === "f.io";
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    if (open_) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open_]);

  useEffect(() => {
    if (!open_) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open_]);

  async function submit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    const dest = await pickDownloadDest();
    if (!dest) return;
    const quality = isFrameio ? (mode === "original" ? "original" : `proxy-${proxyRes}`) : undefined;
    enqueueUrl(trimmed, dest, quality);
    toast(trimmed.toLowerCase().startsWith("magnet:") ? "Queued torrent" : "Queued download from URL", "success");
    setUrl("");
    setOpen(false);
  }

  async function addTorrentFile() {
    const picked = await open({ multiple: false, filters: [{ name: "Torrent", extensions: ["torrent"] }] });
    if (typeof picked !== "string") return;
    const dest = await pickDownloadDest();
    if (!dest) return;
    enqueueTorrentFile(picked, dest);
    toast("Queued torrent", "success");
    setOpen(false);
  }

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      saveRaw(FOLDER_KEY, picked);
      toast("Download folder set", "success");
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <Button variant="download" onClick={() => setOpen((o) => !o)} data-tip="Add a web download link">
        <Plus size={15} /> Add download
      </Button>

      {open_ && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="animate-pop absolute right-0 top-[calc(100%+8px)] z-50 w-[420px] rounded-[12px] border border-[var(--line2)] bg-[var(--card)] p-4 shadow-[var(--shadow-lg)]">
            <div className="mb-1 flex items-center gap-2">
              <Globe size={15} className="shrink-0 text-[var(--acc)]" />
              <h2 className="text-sm font-semibold text-[var(--ink)]">Download from a link</h2>
              <button onClick={() => setOpen(false)} aria-label="Close" className="ml-auto text-[var(--faint)] hover:text-[var(--ink)]">
                <X size={15} />
              </button>
            </div>
            <p className="mb-3 text-xs text-[var(--faint)]">Paste a direct file URL, a <span className="text-[var(--ink)]">WeTransfer</span> / <span className="text-[var(--ink)]">Filemail</span> / <span className="text-[var(--ink)]">Frame.io</span> link, or a <span className="text-[var(--ink)]">magnet</span> link — it downloads alongside your Drive/Dropbox transfers.</p>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Globe size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
                <input
                  ref={inputRef}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                  placeholder="Paste a URL, magnet, or WeTransfer/Filemail/Frame.io link…"
                  aria-label="URL to download"
                  className="focus-accent w-full rounded-[8px] border border-[var(--line)] bg-[var(--soft)] py-2 pl-9 pr-3 text-sm text-[var(--ink)] placeholder:text-[var(--faint)]"
                />
              </div>
              <button
                onClick={() => void pickFolder()}
                aria-label="Choose download folder"
                data-tip="Choose download folder"
                className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-[var(--line)] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
              >
                <Folder size={15} />
              </button>
            </div>
            {isFrameio && (
              <div className="mt-3 rounded-[9px] border border-[var(--line)] bg-[var(--soft)] p-2.5">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--faint)]">Frame.io quality</div>
                <div className="flex gap-1.5">
                  {(["original", "proxy"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`h-7 flex-1 rounded-[7px] border px-2 text-[12px] font-semibold ${
                        mode === m ? "border-[var(--acc)] bg-[var(--acc)] text-[var(--onacc)]" : "border-[var(--line)] text-[var(--mut)] hover:border-[var(--line2)]"
                      }`}
                    >
                      {m === "original" ? "Original" : "Proxy"}
                    </button>
                  ))}
                </div>
                {mode === "proxy" && (
                  <select
                    value={proxyRes}
                    onChange={(e) => setProxyRes(e.target.value as typeof proxyRes)}
                    className="focus-accent mt-2 w-full rounded-[7px] border border-[var(--line)] bg-[var(--card)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                  >
                    <option value="highest">Highest resolution</option>
                    <option value="1080">1080p</option>
                    <option value="720">720p</option>
                    <option value="smallest">Smallest</option>
                  </select>
                )}
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  {mode === "original" ? "Full-resolution master files." : "Smaller H.264 preview renditions."}
                </p>
              </div>
            )}
            <div className="mt-3 flex items-center justify-between">
              <button onClick={() => void addTorrentFile()} className="text-[12px] font-medium text-[var(--faint)] hover:text-[var(--ink)]" data-tip="Load a .torrent file from disk">
                Add .torrent file…
              </button>
              <Button variant="download" onClick={() => void submit()} disabled={!url.trim()}>
                <Plus size={15} /> Download
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
