import { useMemo } from "react";
import { X, Check, AlertCircle, Ban, Clock, Pause, Play, Download } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "../store/app";
import { useTransfers, type QueueItem } from "../store/transfers";
import { useHistory, type HistoryEntry } from "../store/history";
import { fileType } from "../lib/file-types";
import { laneOf } from "../lib/lane";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import { categoryFor, CATEGORIES, type Category } from "../lib/categories";
import { UrlDownload } from "./UrlDownload";
import { DownloadDetail } from "./DownloadDetail";
import { SpeedGraph } from "./ui/SpeedGraph";
import type { JobStatus } from "../lib/tauri/commands";

/** Category filter: "All" plus every category. */
type Filter = "All" | Category;
const FILTERS: Filter[] = ["All", ...CATEGORIES];

function pct(j: JobStatus): number {
  if (j.totalBytes > 0) return Math.min(100, Math.round((j.bytes / j.totalBytes) * 100));
  return 0;
}

/** Small category chip. */
function CategoryChip({ category }: { category: Category }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-2)]">
      {category}
    </span>
  );
}

/** Gated secondary downloads show a distinct "waiting for primary" message. */
function isGated(q: QueueItem): boolean {
  return !!q.autoPaused && !q.paused;
}

/**
 * GENERAL / WEB DOWNLOADS view. Shows ONLY secondary-lane downloads
 * (laneOf(accountId) === "secondary", i.e. http / ytdlp captures): the URL
 * input, category filter tabs, then active + queued + history rows, each with
 * its category chip. Clicking a row opens the per-download detail panel.
 */
export function GeneralDownloads({ filter, detail }: { filter: Category | "All"; detail?: string }) {
  const setWebCategory = useApp((s) => s.setWebCategory);
  const openDetail = useApp((s) => s.openWebDownloadDetail);

  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  // Reused as-is from the primary Downloads screen: the lane gate auto-pauses
  // secondary whenever primary is busy, so this combined total already tracks
  // whichever lane is actually transferring.
  const totalSpeedHistory = useTransfers((s) => s.totalSpeedHistory);
  const { cancel, pause, resumePaused, removeQueued, enqueue } = useTransfers(
    useShallow((s) => ({
      cancel: s.cancel,
      pause: s.pause,
      resumePaused: s.resumePaused,
      removeQueued: s.removeQueued,
      enqueue: s.enqueue,
    })),
  );
  const history = useHistory((s) => s.items);
  const clear = useHistory((s) => s.clear);
  const removeEntry = useHistory((s) => s.removeEntry);

  // Secondary-lane only across all three sources.
  const webActive = useMemo(
    () => jobs.filter((j) => laneOf(j.accountId) === "secondary" && !j.finished && !j.cancelled),
    [jobs],
  );
  const webQueue = useMemo(
    () => queue.filter((q) => laneOf(q.accountId) === "secondary"),
    [queue],
  );
  const webHistory = useMemo(
    () => history.filter((h) => laneOf(h.accountId) === "secondary"),
    [history],
  );

  // Category filter, "All" passes everything; otherwise match the file's category.
  const match = (name: string, cat?: Category) =>
    filter === "All" || (cat ?? categoryFor(name)) === filter;
  const active = webActive.filter((j) => match(j.name));
  const queued = webQueue.filter((q) => match(q.item.name));
  const hist = webHistory.filter((h) => match(h.name, h.category));
  const totalSpeed = active.reduce((s, j) => s + Math.max(0, j.speed), 0);

  // Detail panel takes over the whole view when a download is pinned.
  if (detail) return <DownloadDetail id={detail} />;

  const empty = active.length === 0 && queued.length === 0 && hist.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-7 pt-6">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.025em] text-[var(--ink)]">Web Downloads</h1>
          <p className="mt-1 text-[13px] text-[var(--mut)]">Grab any direct file URL alongside your Drive/Dropbox transfers.</p>
        </div>
        <div className="flex items-center gap-3">
          {webHistory.length > 0 && (
            <button onClick={() => clear()} className="text-xs font-medium text-[var(--faint)] hover:text-[var(--ink)]">Clear history</button>
          )}
          <UrlDownload />
        </div>
      </div>

      {/* Category filter pills. */}
      <div className="flex flex-wrap items-center gap-1.5 px-7 pb-3 pt-[18px]">
        {FILTERS.map((f) => {
          const on = filter === f;
          return (
            <button
              key={f}
              onClick={() => setWebCategory(f)}
              className={`h-8 rounded-full border px-[15px] text-[12.5px] font-semibold ${
                on ? "border-[var(--acc)] bg-[var(--acc)] text-[var(--onacc)]" : "border-[var(--line)] bg-[var(--card)] text-[var(--mut)] hover:border-[var(--line2)]"
              }`}
            >
              {f}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
        {active.length > 0 && (
          <div className="mb-4 rounded-[9px] border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold tracking-wide text-[var(--text-3)]">
              <span>COMBINED SPEED</span>
              <span className="tnum text-[13px] font-semibold text-[var(--dl)]">{formatSpeed(totalSpeed)}</span>
            </div>
            <div className="h-14">
              <SpeedGraph samples={totalSpeedHistory} />
            </div>
          </div>
        )}

        {(active.length > 0 || queued.length > 0) && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-3)]">IN PROGRESS</div>
            <div className="flex flex-col gap-1.5">
              {active.map((j) => {
                const ft = fileType(j.name, false);
                return (
                  <button
                    key={j.jobId}
                    onClick={() => openDetail(`j${j.jobId}`)}
                    title="View download details"
                    className="flex w-full items-center gap-3 rounded-[9px] border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-left hover:border-[var(--border-strong)]"
                  >
                    <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0" />
                    <div className="w-56 min-w-0 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-[var(--text)]">{j.name}</span>
                        <CategoryChip category={categoryFor(j.name)} />
                      </div>
                      <div className="truncate text-xs text-[var(--text-3)]">{j.dest}</div>
                    </div>
                    <div className="flex flex-1 items-center gap-3">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hover)]">
                        <div className="h-full rounded-full bg-[var(--dl)]" style={{ width: `${pct(j)}%` }} />
                      </div>
                      <span className="tnum w-40 shrink-0 text-right text-xs text-[var(--text-3)]">
                        {formatBytes(j.bytes)} / {formatBytes(j.totalBytes || j.bytes)} · {formatSpeed(j.speed)} · {formatEta(j.eta)}
                      </span>
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void pause(j.jobId);
                      }}
                      aria-label={`Pause ${j.name}`}
                      title="Pause"
                      className="text-[var(--text-3)] hover:text-[var(--accent)]"
                    >
                      <Pause size={15} />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void cancel(j.jobId);
                      }}
                      aria-label={`Cancel ${j.name}`}
                      title="Cancel"
                      className="text-[var(--text-3)] hover:text-[var(--error)]"
                    >
                      <X size={15} />
                    </span>
                  </button>
                );
              })}
              {queued.map((q, i) => {
                const ft = fileType(q.item.name, q.item.isDir);
                return (
                  <div
                    key={q.id}
                    className="flex items-center gap-3 rounded-[9px] border border-[var(--border)] px-4 py-3"
                  >
                    <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0 opacity-70" />
                    <div className="w-56 min-w-0 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-[var(--text-2)]">{q.item.name}</span>
                        <CategoryChip category={categoryFor(q.item.name)} />
                      </div>
                      <div className="truncate text-xs text-[var(--text-3)]">{q.dest}</div>
                    </div>
                    <div className="flex flex-1 items-center gap-2 text-xs text-[var(--text-3)]">
                      {isGated(q) ? <Clock size={13} /> : q.paused ? <Pause size={13} /> : <Clock size={13} />}
                      {isGated(q)
                        ? "Waiting for Drive/Dropbox to finish"
                        : q.paused
                          ? `Paused · ${formatBytes(q.resumedBytes ?? 0)} done`
                          : q.resumedBytes
                            ? `Resuming · ${formatBytes(q.resumedBytes)} done`
                            : `Queued · #${i + 1}`}
                    </div>
                    {q.paused && (
                      <button
                        onClick={() => resumePaused(q.id)}
                        aria-label={`Resume ${q.item.name}`}
                        title="Resume"
                        className="text-[var(--text-3)] hover:text-[var(--accent)]"
                      >
                        <Play size={15} />
                      </button>
                    )}
                    <button
                      onClick={() => removeQueued(q.id)}
                      aria-label={`Remove ${q.item.name}`}
                      title="Remove from queue"
                      className="text-[var(--text-3)] hover:text-[var(--error)]"
                    >
                      <X size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div>
          {(active.length > 0 || queued.length > 0) && hist.length > 0 && (
            <div className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-3)]">HISTORY</div>
          )}
          {empty ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-weak)] text-[var(--text-3)]">
                <Download size={20} />
              </div>
              <div className="text-sm font-medium text-[var(--text)]">
                {filter === "All" ? "No web downloads yet" : `No ${filter.toLowerCase()} downloads`}
              </div>
              <p className="max-w-xs text-xs text-[var(--text-3)]">
                Paste a direct file URL above to download it from the web, it runs alongside your Drive/Dropbox transfers.
              </p>
            </div>
          ) : (
            <div className="flex flex-col">
              {hist.map((h) => (
                <HistoryRow
                  key={h.jobId}
                  entry={h}
                  onOpen={() => openDetail(`j${h.jobId}`)}
                  onResume={() => {
                    enqueue(h.accountId, [h.item!], h.dest);
                    removeEntry(h.jobId);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryRow({
  entry: h,
  onOpen,
  onResume,
}: {
  entry: HistoryEntry;
  onOpen: () => void;
  onResume: () => void;
}) {
  const ft = fileType(h.name, false);
  const badge =
    h.status === "success"
      ? { Icon: Check, color: "var(--success)", label: "Completed" }
      : h.status === "cancelled"
        ? { Icon: Ban, color: "var(--text-3)", label: "Cancelled" }
        : { Icon: AlertCircle, color: "var(--error)", label: "Failed" };
  return (
    <button
      onClick={onOpen}
      title="View download details"
      className="flex w-full items-center gap-3 border-b border-[var(--border)]/60 py-3 text-left hover:bg-[var(--hover)]"
    >
      <ft.Icon size={20} style={{ color: ft.color }} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm text-[var(--text)]" title={h.name}>{h.name}</span>
          <CategoryChip category={h.category ?? categoryFor(h.name)} />
        </div>
        {h.status === "failed" && h.error ? (
          <div className="truncate text-xs text-[var(--error)]" title={h.error}>{h.error}</div>
        ) : (
          <div className="truncate text-xs text-[var(--text-3)]" title={h.dest}>{h.dest}</div>
        )}
      </div>
      <span className="tnum w-24 shrink-0 text-right text-sm text-[var(--text-2)]">{formatBytes(h.size)}</span>
      <span className="tnum w-40 shrink-0 text-right text-xs text-[var(--text-3)]">{new Date(h.at).toLocaleString()}</span>
      {h.status === "failed" && h.item ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onResume();
          }}
          aria-label={`Resume ${h.name}`}
          title="Resume from where it stopped"
          className="flex w-28 shrink-0 items-center justify-end gap-1.5 text-xs text-[var(--accent)] hover:opacity-80"
        >
          <Play size={14} /> Resume
        </span>
      ) : (
        <span className="flex w-28 shrink-0 items-center justify-end gap-1.5 text-xs" style={{ color: badge.color }}>
          <badge.Icon size={14} /> {badge.label}
        </span>
      )}
    </button>
  );
}
