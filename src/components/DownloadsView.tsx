import { useMemo } from "react";
import { X, Clock, Pause, Play, Globe, Download } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp, type DownloadFilter } from "../store/app";
import { useTransfers, type QueueItem } from "../store/transfers";
import { useHistory } from "../store/history";
import { laneOf } from "../lib/lane";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import { GeneralDownloads } from "./GeneralDownloads";
import type { JobStatus } from "../lib/tauri/commands";

/** id → display label, so rows look up account names without scanning `accounts`. */
type LabelOf = (accountId: string) => string;

const TABS: { key: DownloadFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function pct(j: JobStatus): number {
  if (j.totalBytes > 0) return Math.min(100, Math.round((j.bytes / j.totalBytes) * 100));
  return 0;
}

function AccountLabel({ accountId, labelOf }: { accountId: string; labelOf: LabelOf }) {
  return <>{labelOf(accountId)}</>;
}

/** Small lane badge: "Web" for secondary, the account label for primary. */
function LaneBadge({ accountId, labelOf }: { accountId: string; labelOf: LabelOf }) {
  if (laneOf(accountId) === "secondary") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-2)]">
        <Globe size={10} /> Web
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-2)]">
      {labelOf(accountId)}
    </span>
  );
}

/** Gated secondary downloads show a distinct "waiting for primary" message. */
function isGated(q: QueueItem): boolean {
  return !!q.autoPaused && !q.paused;
}

export function DownloadsView({ filter }: { filter: DownloadFilter }) {
  // AppShell mounts this view for BOTH the primary Drive/Dropbox transfers and
  // the GENERAL / WEB DOWNLOADS sub-view (they share the "downloads" view kind).
  // When `web` is set we delegate entirely to <GeneralDownloads/>; otherwise we
  // render the primary transfers list below.
  const web = useApp((s) => (s.view.kind === "downloads" ? s.view.web : false));
  const webCategory = useApp((s) => (s.view.kind === "downloads" ? s.view.category : undefined));
  const webDetail = useApp((s) => (s.view.kind === "downloads" ? s.view.detail : undefined));
  if (web) return <GeneralDownloads filter={webCategory ?? "All"} detail={webDetail} />;

  return <PrimaryDownloads filter={filter} />;
}

function PrimaryDownloads({ filter }: { filter: DownloadFilter }) {
  const showDownloads = useApp((s) => s.showDownloads);
  // Narrow selectors: the data slices (jobs/queue) re-render this view as they
  // change, while the action slice is shallow-compared so its stable refs never
  // trigger a re-render on their own.
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
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
  // One memoized id → label map instead of an accounts.find() scan per row.
  const accounts = useApp((s) => s.accounts);
  const labelOf = useMemo<LabelOf>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a.label]));
    return (id: string) => byId.get(id) ?? id;
  }, [accounts]);

  // The primary Downloads view now shows ONLY Drive/Dropbox (primary-lane)
  // transfers; web (secondary-lane) downloads live in the GENERAL DOWNLOADS view.
  const primaryJobs = useMemo(() => jobs.filter((j) => laneOf(j.accountId) === "primary"), [jobs]);
  const primaryQueue = useMemo(() => queue.filter((q) => laneOf(q.accountId) === "primary"), [queue]);
  const primaryHistory = useMemo(
    () => history.filter((h) => laneOf(h.accountId) === "primary"),
    [history],
  );

  const active = primaryJobs.filter((j) => !j.finished && !j.cancelled);
  const showActive = filter === "all" || filter === "active";
  const histFiltered = primaryHistory.filter((h) =>
    filter === "completed" ? h.status === "success" : filter === "failed" ? h.status !== "success" : true,
  );
  const showHistory = filter !== "active";
  const totalSpeed = active.reduce((s, j) => s + Math.max(0, j.speed), 0);
  const completedCount = primaryHistory.filter((h) => h.status === "success").length;
  const ext = (name: string) => (name.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 px-7 pt-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.025em] text-[var(--ink)]">Downloads</h1>
            <p className="mt-1 text-[13px] text-[var(--mut)]">
              {active.length} active · <span className="font-semibold text-[var(--dl)]">{totalSpeed > 0 ? `${formatSpeed(totalSpeed)}` : "0 B/s"}</span> total · {completedCount} completed
            </p>
          </div>
          {primaryHistory.length > 0 && (
            <button onClick={() => clear()} className="text-xs font-medium text-[var(--faint)] hover:text-[var(--ink)]">Clear history</button>
          )}
        </div>
        <div className="mt-[18px] flex items-center gap-1.5">
          {TABS.map((t) => {
            const on = filter === t.key;
            return (
              <button
                key={t.key}
                onClick={() => showDownloads(t.key)}
                className={`h-8 rounded-full border px-[15px] text-[12.5px] font-semibold ${
                  on ? "border-[var(--acc)] bg-[var(--acc)] text-[var(--onacc)]" : "border-[var(--line)] bg-[var(--card)] text-[var(--mut)] hover:border-[var(--line2)]"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-7 pb-6 pt-5">
        {showActive && (active.length > 0 || primaryQueue.length > 0) && (
          <div className="mb-6">
            <div className="mb-3 font-mono text-[11px] font-semibold tracking-[0.06em] text-[var(--faint)]">IN PROGRESS</div>
            <div className="flex flex-col gap-3">
              {active.map((j) => (
                <div key={j.jobId} className="rounded-[15px] border border-[var(--line)] bg-[var(--card)] p-4">
                  <div className="mb-3 flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-[var(--accw)] font-mono text-[10px] font-semibold text-[var(--mut)]">{ext(j.name)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-semibold text-[var(--ink)]">{j.name}</span>
                        <LaneBadge accountId={j.accountId} labelOf={labelOf} />
                      </div>
                      <div className="truncate text-[11.5px] text-[var(--faint)]"><AccountLabel accountId={j.accountId} labelOf={labelOf} /></div>
                    </div>
                    <span className="tnum text-[13px] font-semibold text-[var(--dl)]">{pct(j)}%</span>
                    <button onClick={() => pause(j.jobId)} aria-label={`Pause ${j.name}`} data-tip="Pause" className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-[var(--line)] bg-[var(--card)] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
                      <Pause size={14} />
                    </button>
                    <button onClick={() => cancel(j.jobId)} aria-label={`Cancel ${j.name}`} data-tip="Cancel" className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-[var(--line)] bg-[var(--card)] text-[var(--mut)] hover:border-[var(--err)] hover:bg-[var(--errw)] hover:text-[var(--err)]">
                      <X size={14} />
                    </button>
                  </div>
                  <div className="h-[7px] overflow-hidden rounded-full bg-[var(--soft)]">
                    <div className="h-full rounded-full bg-[var(--dl)]" style={{ width: `${pct(j)}%` }} />
                  </div>
                  <div className="mt-2 flex justify-between font-mono text-[11.5px] text-[var(--faint)]">
                    <span>{formatBytes(j.bytes)} of {formatBytes(j.totalBytes || j.bytes)}</span>
                    <span><span className="text-[var(--dl)]">{formatSpeed(j.speed)}</span> · {formatEta(j.eta)} left</span>
                  </div>
                </div>
              ))}
              {primaryQueue.map((q, i) => (
                <div key={q.id} className="flex items-center gap-3 rounded-[15px] border border-[var(--line)] p-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-[var(--soft)] font-mono text-[10px] font-semibold text-[var(--faint)]">{ext(q.item.name)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold text-[var(--mut)]">{q.item.name}</span>
                      <LaneBadge accountId={q.accountId} labelOf={labelOf} />
                    </div>
                    <div className="flex items-center gap-1.5 truncate text-[11.5px] text-[var(--faint)]">
                      {isGated(q) ? <Clock size={12} /> : q.paused ? <Pause size={12} /> : <Clock size={12} />}
                      {isGated(q)
                        ? "Waiting for Drive/Dropbox to finish"
                        : q.paused
                          ? `Paused · ${formatBytes(q.resumedBytes ?? 0)} done`
                          : q.resumedBytes
                            ? `Resuming · ${formatBytes(q.resumedBytes)} done`
                            : `Queued · #${i + 1}`}
                    </div>
                  </div>
                  {q.paused && (
                    <button onClick={() => resumePaused(q.id)} aria-label={`Resume ${q.item.name}`} data-tip="Resume" className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-[var(--line)] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--dl)]">
                      <Play size={14} />
                    </button>
                  )}
                  <button onClick={() => removeQueued(q.id)} aria-label={`Remove ${q.item.name}`} data-tip="Remove from queue" className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-[var(--line)] text-[var(--mut)] hover:border-[var(--err)] hover:text-[var(--err)]">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {showHistory && (
          <div>
            {filter === "all" && <div className="mb-3 font-mono text-[11px] font-semibold tracking-[0.06em] text-[var(--faint)]">HISTORY</div>}
            {histFiltered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accw)] text-[var(--faint)]">
                  <Download size={20} />
                </div>
                <div className="text-sm font-semibold text-[var(--ink)]">
                  {filter === "failed" ? "No failed downloads" : filter === "completed" ? "No completed downloads yet" : "No downloads yet"}
                </div>
                <p className="max-w-xs text-xs text-[var(--faint)]">
                  Select files in a connected account and hit Download, or paste a URL to grab it from the web.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-[15px] border border-[var(--line)] bg-[var(--card)]">
                {histFiltered.map((h) => {
                  const badge =
                    h.status === "success"
                      ? { color: "var(--ok)", label: "Completed" }
                      : h.status === "cancelled"
                        ? { color: "var(--faint)", label: "Cancelled" }
                        : { color: "var(--err)", label: "Failed" };
                  return (
                    <div key={h.jobId} className="flex items-center gap-3 border-b border-[var(--line)] px-[18px] py-3 last:border-b-0">
                      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--accw)] font-mono text-[9px] font-semibold text-[var(--mut)]">{ext(h.name)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-[var(--ink)]" data-tip={h.name}>{h.name}</div>
                        {h.status === "failed" && h.error ? (
                          <div className="truncate text-[11.5px] text-[var(--err)]" data-tip={h.error}>{h.error}</div>
                        ) : (
                          <div className="truncate text-[11.5px] text-[var(--faint)]" data-tip={h.dest}>
                            <AccountLabel accountId={h.accountId} labelOf={labelOf} /> · {h.dest}
                          </div>
                        )}
                      </div>
                      <span className="tnum w-[74px] shrink-0 text-right font-mono text-[12.5px] text-[var(--mut)]">{formatBytes(h.size)}</span>
                      <span className="tnum w-[150px] shrink-0 text-right text-[11.5px] text-[var(--faint)]">{new Date(h.at).toLocaleString()}</span>
                      {h.status === "failed" && h.item ? (
                        <button
                          onClick={() => { enqueue(h.accountId, [h.item!], h.dest); removeEntry(h.jobId); }}
                          aria-label={`Resume ${h.name}`}
                          data-tip="Resume from where it stopped"
                          className="flex w-[110px] shrink-0 items-center justify-end gap-1.5 text-[11.5px] font-semibold text-[var(--dl)] hover:opacity-80"
                        >
                          <Play size={13} /> Resume
                        </button>
                      ) : (
                        <span className="flex w-[110px] shrink-0 items-center justify-end gap-1.5 text-[11.5px] font-semibold" style={{ color: badge.color }}>
                          <span className="h-[7px] w-[7px] rounded-full" style={{ background: badge.color }} /> {badge.label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
