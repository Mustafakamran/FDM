import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link2, Copy, Check, Loader2, X } from "lucide-react";
import { driveShareLink, dropboxShareLink, type Account } from "../lib/tauri/commands";
import type { RcItem } from "../lib/rc/browse";

/**
 * Small "Copy link" popover (Dropbox-style): fetches or creates an
 * anyone-with-the-link share URL for a Drive/Dropbox item, shows it in a
 * selectable field with a Copy button. Drive shares by file id; Dropbox by path.
 */
export function SharePopover({ account, item, onClose }: { account: Account; item: RcItem; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const p =
      account.provider === "drive"
        ? item.ID
          ? driveShareLink(account.id, item.ID)
          : Promise.reject(new Error("This item has no Drive id to share."))
        : dropboxShareLink(account.id, item.Path);
    p.then((u) => alive && setUrl(u)).catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [account, item]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setErr("Couldn’t write to the clipboard.");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4" onMouseDown={onClose}>
      <div
        className="animate-rise w-full max-w-[460px] rounded-[14px] border border-[var(--border-strong)] bg-[var(--surface)] p-5 shadow-[var(--shadow-lg)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
            <Link2 size={15} className="shrink-0 text-[var(--accent)]" />
            <span className="shrink-0">Copy link to</span>
            <span className="truncate font-normal text-[var(--text-2)]">{item.Name}</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-[var(--text-3)] hover:text-[var(--text)]">
            <X size={16} />
          </button>
        </div>

        <div className="mt-4">
          {err ? (
            <p className="text-[12.5px] leading-relaxed text-[var(--error)]">{err}</p>
          ) : url == null ? (
            <div className="flex items-center gap-2 py-1 text-[13px] text-[var(--text-2)]">
              <Loader2 size={14} className="animate-spin" /> Creating link…
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-[9px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[12.5px] text-[var(--text-2)] focus-accent"
              />
              <button
                onClick={copy}
                className="flex shrink-0 items-center gap-1.5 rounded-[9px] bg-[var(--accent)] px-3 py-2 text-[12.5px] font-semibold text-[var(--accent-ink)] transition active:translate-y-px"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>

        {!err && <p className="mt-3 text-[11px] text-[var(--faint)]">Anyone with this link can view.</p>}
      </div>
    </div>,
    document.body,
  );
}
