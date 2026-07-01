import { useEffect, useRef, useState } from "react";
import { Globe, Folder, Plus, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { Button } from "./ui";
import { FOLDER_KEY } from "../lib/ingest";
import { loadRaw, saveRaw } from "../lib/persisted";

/**
 * "Add web download" — a compact button that opens a dropdown with the URL input,
 * a destination-folder picker, and Download. (Replaces the always-open box so the
 * Web Downloads screen leads with the list, not a form.) Exercises the SECONDARY
 * scheduling lane (account id "http") so it never disturbs primary Drive/Dropbox.
 */
export function UrlDownload() {
  const enqueueUrl = useTransfers((s) => s.enqueueUrl);
  const toast = useToasts((s) => s.push);
  const [url, setUrl] = useState("");
  const [open_, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    let dest = loadRaw(FOLDER_KEY, "");
    if (!dest) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      dest = picked;
    }
    enqueueUrl(trimmed, dest);
    toast("Queued download from URL", "success");
    setUrl("");
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
            <p className="mb-3 text-xs text-[var(--faint)]">Paste any direct file URL; it downloads alongside your Drive/Dropbox transfers.</p>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Globe size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
                <input
                  ref={inputRef}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                  placeholder="Paste a URL to download…"
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
            <div className="mt-3 flex justify-end">
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
