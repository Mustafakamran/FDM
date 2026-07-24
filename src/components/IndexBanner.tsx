import { useMemo } from "react";
import { Loader2, FolderSearch, X } from "lucide-react";
import { useIndex } from "../store/index-store";
import { useApp } from "../store/app";
import { formatBytes } from "../lib/format";

/**
 * Floating indexing status — the crawl equivalent of the Transfers drawer. Shows
 * every account that's currently indexing / re-indexing (folders scanned, files
 * found, bytes) with a Cancel, wherever you are in the app. Centered along the
 * bottom.
 */
export function IndexBanner() {
  const byAccount = useIndex((s) => s.byAccount);
  const cancel = useIndex((s) => s.cancel);
  const accounts = useApp((s) => s.accounts);
  const labelOf = useMemo(() => {
    const m = new Map(accounts.map((a) => [a.id, a.label]));
    return (id: string) => m.get(id) ?? id;
  }, [accounts]);

  const active = Object.entries(byAccount).filter(([, e]) => e.status === "crawling" || e.status === "loading");
  if (active.length === 0) return null;

  return (
    <div className="animate-pop fixed bottom-3 left-1/2 z-40 flex w-[360px] max-w-[calc(100vw-24px)] -translate-x-1/2 flex-col gap-2 rounded-[14px] border border-[var(--line2)] bg-[var(--card)] p-3 shadow-[var(--shadow-lg)]">
      {active.map(([id, e]) => {
        const p = e.progress;
        const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        return (
          <div key={id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <FolderSearch size={14} className="shrink-0 text-[var(--acc)]" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--ink)]">Indexing {e.target ?? labelOf(id)}</span>
              <Loader2 size={13} className="shrink-0 animate-spin text-[var(--faint)]" />
              <button onClick={() => void cancel(id)} title="Stop" aria-label="Stop indexing" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--err)]">
                <X size={14} />
              </button>
            </div>
            {/* Progress bar (folders scanned) + running counts. */}
            <span className="block h-1 overflow-hidden rounded-full bg-[var(--soft)]">
              <span className="block h-full rounded-full bg-[var(--acc)] transition-[width]" style={{ width: p.total > 0 ? `${pct}%` : "35%" }} />
            </span>
            <div className="flex items-center justify-between font-mono text-[10.5px] text-[var(--faint)]">
              <span>
                {p.total > 0 ? `${p.done.toLocaleString()} / ${p.total.toLocaleString()} folders` : `${p.done.toLocaleString()} folders`}
                {p.files > 0 ? ` · ${p.files.toLocaleString()} files` : ""}
              </span>
              {(p.bytes ?? 0) > 0 && <span>{formatBytes(p.bytes ?? 0)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
