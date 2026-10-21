import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, X, Copy, Check, ChevronRight } from "lucide-react";
import { useErrorDialog } from "../store/error-dialog";

/**
 * App-wide error dialog. Shows a friendly title + message, with the raw technical
 * detail tucked behind a disclosure (copyable for support). Mount ONCE near the
 * app root; renders nothing when no error is open. Esc or backdrop closes.
 */
export function ErrorDialog() {
  const current = useErrorDialog((s) => s.current);
  const close = useErrorDialog((s) => s.close);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOpen(false);
    setCopied(false);
  }, [current]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, close]);

  if (!current) return null;

  const copy = () => {
    if (!current.detail) return;
    void navigator.clipboard?.writeText(current.detail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return createPortal(
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-black/40 p-4" onMouseDown={close}>
      <div className="animate-pop w-[460px] max-w-full overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-lg)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 px-5 pt-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--errw)]">
            <AlertCircle size={18} className="text-[var(--err)]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">{current.title}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--mut)]">{current.message}</p>
          </div>
          <button onClick={close} aria-label="Close" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
            <X size={16} />
          </button>
        </div>

        {current.detail && (
          <div className="px-5 pt-3">
            <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[12px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">
              <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} /> Technical details
            </button>
            {open && (
              <div className="relative mt-2">
                <pre className="select-text max-h-40 overflow-auto rounded-[9px] border border-[var(--line)] bg-[var(--bg)] p-3 pr-10 text-[11px] leading-relaxed text-[var(--mut)] whitespace-pre-wrap break-words">{current.detail}</pre>
                <button onClick={copy} data-tip="Copy" aria-label="Copy details" className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
                  {copied ? <Check size={13} className="text-[var(--ok)]" /> : <Copy size={13} />}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 px-5 py-4">
          <button onClick={close} className="rounded-[9px] border border-[var(--line)] px-4 py-2 text-[13px] font-semibold text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
            Close
          </button>
          {current.onRetry && (
            <button
              onClick={() => { const r = current.onRetry; close(); r?.(); }}
              className="rounded-[9px] border border-[var(--acc)] bg-[var(--acc)] px-4 py-2 text-[13px] font-semibold text-[var(--onacc)] hover:opacity-90"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
