import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X, Check, AlertCircle, Ban, Clock, Pause, Play, Globe, ArrowDown, ArrowUp, ArrowDownUp } from "lucide-react";
import { useTransfers, type QueueItem } from "../store/transfers";
import { useApp } from "../store/app";
import { fileType } from "../lib/file-types";
import { laneOf } from "../lib/lane";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import type { JobStatus } from "../lib/tauri/commands";

/** id → display label, so rows look up account names without scanning `accounts`. */
type LabelOf = (accountId: string) => string;

type Tab = "all" | "active" | "completed" | "failed";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

/** Small lane badge: "Web" for secondary, the account label for primary. */
function LaneBadge({ accountId, labelOf }: { accountId: string; labelOf: LabelOf }) {
  if (laneOf(accountId) === "secondary") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--soft)] px-1.5 py-px text-[9px] font-medium text-[var(--faint)]">
        <Globe size={9} /> Web
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--soft)] px-1.5 py-px text-[9px] font-medium text-[var(--faint)]">
      {labelOf(accountId)}
    </span>
  );
}

const QueueRow = memo(function QueueRow({ q, position, labelOf }: { q: QueueItem; position: number; labelOf: LabelOf }) {
  const removeQueued = useTransfers((s) => s.removeQueued);
  const resumePaused = useTransfers((s) => s.resumePaused);
  const ft = fileType(q.item.name, q.item.isDir);
  const gated = !!q.autoPaused && !q.paused;
  return (
    <div className="group flex items-center gap-2.5 px-3.5 py-2">
      <span className="relative shrink-0">
        <ft.Icon size={17} style={{ color: ft.color }} className="opacity-60" />
        <ArrowDown size={9} className="absolute -bottom-1 -right-1 rounded-full bg-[var(--card)] text-[var(--faint)]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-[var(--mut)]" title={q.item.name}>{q.item.name}</span>
          <LaneBadge accountId={q.accountId} labelOf={labelOf} />
        </div>
        <div className="flex items-center gap-1 text-[10.5px] text-[var(--faint)]">
          {gated ? <Clock size={10} /> : q.paused ? <Pause size={10} /> : <Clock size={10} />}
          {gated
            ? "Waiting for Drive/Dropbox…"
            : q.paused
              ? `Paused · ${formatBytes(q.resumedBytes ?? 0)} done`
              : q.resumedBytes
                ? `Resuming · ${formatBytes(q.resumedBytes)} done`
                : `Queued · #${position}`}
        </div>
      </div>
      {q.paused && (
        <button onClick={() => resumePaused(q.id)} aria-label={`Resume ${q.item.name}`} title="Resume" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--soft)] hover:text-[var(--acc)] group-hover:opacity-100">
          <Play size={13} />
        </button>
      )}
      <button onClick={() => removeQueued(q.id)} aria-label={`Remove ${q.item.name}`} title="Remove from queue" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--soft)] hover:text-[var(--err)] group-hover:opacity-100">
        <X size={13} />
      </button>
    </div>
  );
});

function pct(j: JobStatus): number {
  if (j.finished && j.success) return 100;
  if (j.totalBytes > 0) return Math.min(100, Math.round((j.bytes / j.totalBytes) * 100));
  return 0;
}

// listJobs() returns a freshly-deserialized JobStatus for every job on every 1s
// tick even when nothing changed, so a bare memo() would re-render anyway.
// Compare the rendered fields so idle rows skip re-render while active ones update.
function jobRowPropsEqual(prev: { job: JobStatus; labelOf: LabelOf }, next: { job: JobStatus; labelOf: LabelOf }): boolean {
  return (
    prev.labelOf === next.labelOf &&
    prev.job.jobId === next.job.jobId &&
    prev.job.bytes === next.job.bytes &&
    prev.job.totalBytes === next.job.totalBytes &&
    prev.job.speed === next.job.speed &&
    prev.job.finished === next.job.finished &&
    prev.job.success === next.job.success &&
    prev.job.cancelled === next.job.cancelled &&
    prev.job.error === next.job.error &&
    prev.job.eta === next.job.eta
  );
}

const Row = memo(function Row({ job, labelOf }: { job: JobStatus; labelOf: LabelOf }) {
  const cancel = useTransfers((s) => s.cancel);
  const pause = useTransfers((s) => s.pause);
  const dismissUpload = useTransfers((s) => s.dismissUpload);
  const ft = fileType(job.name, false);
  const p = pct(job);
  const active = !job.finished && !job.cancelled;
  const isUpload = job.kind === "upload";
  const Dir = isUpload ? ArrowUp : ArrowDown;
  const failed = job.finished && !job.success && !job.cancelled;
  const barColor = job.cancelled ? "var(--faint)" : failed ? "var(--err)" : "var(--dl)";

  return (
    <div className="group flex items-center gap-2.5 px-3.5 py-2">
      <span className="relative shrink-0">
        <ft.Icon size={17} style={{ color: ft.color }} />
        <Dir size={9} className="absolute -bottom-1 -right-1 rounded-full bg-[var(--card)] text-[var(--faint)]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-[var(--ink)]" title={job.name}>{job.name}</span>
          <LaneBadge accountId={job.accountId} labelOf={labelOf} />
        </div>
        {active ? (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--soft)]">
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${p}%`, backgroundColor: barColor }} />
            </div>
            <span className="tnum shrink-0 text-[10px] text-[var(--faint)]">
              {formatBytes(job.bytes)} / {formatBytes(job.totalBytes || job.bytes)}
              {job.speed > 0 ? ` · ${formatSpeed(job.speed)}` : ""}
              {job.eta != null ? ` · ${formatEta(job.eta)} left` : ""}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1 text-[10.5px]">
            {job.cancelled ? (
              <span className="text-[var(--faint)]">Cancelled</span>
            ) : failed ? (
              <span className="truncate text-[var(--err)]" title={job.error}>{job.error || "Failed"}</span>
            ) : (
              <span className="text-[var(--faint)]">{isUpload ? "Uploaded" : "Downloaded"} · {formatBytes(job.totalBytes || job.bytes)}</span>
            )}
          </div>
        )}
      </div>

      <span className="flex w-5 shrink-0 justify-end">
        {job.cancelled ? <Ban size={14} className="text-[var(--faint)]" />
          : job.finished && job.success ? <Check size={14} className="text-[var(--ok)]" />
          : failed ? <span title={job.error}><AlertCircle size={14} className="text-[var(--err)]" /></span>
          : <span className="tnum text-[11px] font-semibold text-[var(--mut)]">{p}%</span>}
      </span>

      {active ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {!isUpload && <button onClick={() => pause(job.jobId)} aria-label={`Pause ${job.name}`} title="Pause" className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--acc)]"><Pause size={13} /></button>}
          <button onClick={() => cancel(job.jobId)} aria-label={`Cancel ${job.name}`} title="Cancel" className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--err)]"><X size={13} /></button>
        </div>
      ) : isUpload ? (
        <button onClick={() => dismissUpload(job.jobId)} aria-label={`Dismiss ${job.name}`} title="Dismiss" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--soft)] hover:text-[var(--ink)] group-hover:opacity-100"><X size={13} /></button>
      ) : (
        <span className="w-6 shrink-0" />
      )}
    </div>
  );
}, jobRowPropsEqual);

/**
 * Floating Transfers drawer (Dropbox-style): a collapsible bottom-right panel
 * showing every background transfer — downloads (active + queued) AND uploads —
 * with progress, ETA, cancel/pause, and All/Active/Completed/Failed tabs. Hidden
 * on the Transfers screen (which has the full table); mounted in AppShell.
 */
export function DownloadsDock() {
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const uploads = useTransfers((s) => s.uploads);
  const clearFinished = useTransfers((s) => s.clearFinished);
  const accounts = useApp((s) => s.accounts);
  const labelOf = useMemo<LabelOf>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a.label]));
    return (id: string) => byId.get(id) ?? id;
  }, [accounts]);
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("all");
  // Manual dismiss: the drawer no longer vanishes on cancel/finish — it stays
  // until the user closes it (X). A new transfer starting un-dismisses it.
  const [dismissed, setDismissed] = useState(false);

  const isActive = (j: JobStatus) => !j.finished && !j.cancelled;
  const activeJobs = jobs.filter(isActive);
  const doneJobs = jobs.filter((j) => !isActive(j));
  const activeUploads = uploads.filter(isActive);
  const doneUploads = uploads.filter((j) => !isActive(j));

  const activeCount = activeJobs.length + activeUploads.length + queue.filter((q) => !q.paused).length;
  // Re-open the drawer when fresh activity starts after a manual dismiss.
  const prevActive = useRef(activeCount);
  useEffect(() => {
    if (activeCount > prevActive.current) setDismissed(false);
    prevActive.current = activeCount;
  }, [activeCount]);

  // Visible while ANY transfer exists (active, queued, or finished history) and
  // the user hasn't dismissed it. Cancelling/finishing keeps it up — the user
  // closes it themselves, or hits Clear to drop finished rows.
  const hasAny = jobs.length > 0 || uploads.length > 0 || queue.length > 0;
  if (!hasAny || dismissed) return null;

  const allTransfers = [...jobs, ...uploads];
  const completedCount = allTransfers.filter((j) => j.finished && j.success).length;
  const failedCount = allTransfers.filter((j) => j.finished && !j.success && !j.cancelled).length;

  // Row order: in-flight first (downloads, uploads), then queued, then finished.
  let dlRows = activeJobs;
  let ulRows = activeUploads;
  let queueRows = queue;
  let doneRows = [...doneJobs, ...doneUploads];
  if (tab === "active") { doneRows = []; }
  else if (tab === "completed") { dlRows = []; ulRows = []; queueRows = []; doneRows = allTransfers.filter((j) => j.finished && j.success); }
  else if (tab === "failed") { dlRows = []; ulRows = []; queueRows = []; doneRows = allTransfers.filter((j) => j.finished && !j.success && !j.cancelled); }

  // Total progress across active downloads + uploads.
  const activeAll = [...activeJobs, ...activeUploads];
  const totalBytes = activeAll.reduce((s, j) => s + (j.totalBytes || 0), 0);
  const doneBytes = activeAll.reduce((s, j) => s + j.bytes, 0);
  const totalPct = totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0;
  const totalSpeed = activeAll.reduce((s, j) => s + Math.max(0, j.speed), 0);

  const empty = dlRows.length === 0 && ulRows.length === 0 && queueRows.length === 0 && doneRows.length === 0;

  return (
    <div className="animate-pop fixed bottom-3 right-3 z-40 flex w-[384px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[14px] border border-[var(--line2)] bg-[var(--card)] shadow-[var(--shadow-lg)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse transfers" : "Expand transfers"} className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
          <ArrowDownUp size={15} className="shrink-0 text-[var(--acc)]" />
          <span>Transfers</span>
          {activeCount > 0 && <span className="tnum text-[var(--mut)]">· {activeCount} active</span>}
          <span title={open ? "Collapse" : "Expand"} className="ml-auto flex h-6 w-6 items-center justify-center text-[var(--faint)]">{open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</span>
        </button>
        {(completedCount > 0 || failedCount > 0) && (
          <button onClick={() => clearFinished()} title="Clear finished" className="shrink-0 text-[11px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">Clear</button>
        )}
        <button onClick={() => setDismissed(true)} title="Close" aria-label="Close transfers" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
          <X size={15} />
        </button>
      </div>

      {open && (
        <>
          {/* Tabs */}
          <div className="flex items-center gap-1 px-3 pb-2">
            {TABS.map((t) => {
              const on = tab === t.key;
              const badge = t.key === "active" ? activeCount : t.key === "completed" ? completedCount : t.key === "failed" ? failedCount : 0;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`h-6 rounded-full px-2.5 text-[11px] font-semibold ${on ? "bg-[var(--acc)] text-[var(--onacc)]" : "text-[var(--mut)] hover:bg-[var(--soft)]"}`}
                >
                  {t.label}{badge > 0 && t.key !== "all" ? ` ${badge}` : ""}
                </button>
              );
            })}
          </div>

          {/* Rows */}
          <div className="max-h-[46vh] min-h-0 divide-y divide-[var(--line)] overflow-auto border-t border-[var(--line)]">
            {empty ? (
              <div className="px-4 py-6 text-center text-[12px] text-[var(--faint)]">Nothing here.</div>
            ) : (
              <>
                {dlRows.map((j) => <Row key={`j${j.jobId}`} job={j} labelOf={labelOf} />)}
                {ulRows.map((j) => <Row key={`u${j.jobId}`} job={j} labelOf={labelOf} />)}
                {queueRows.map((q, i) => <QueueRow key={q.id} q={q} position={i + 1} labelOf={labelOf} />)}
                {doneRows.map((j) => <Row key={`${j.kind}${j.jobId}`} job={j} labelOf={labelOf} />)}
              </>
            )}
          </div>
        </>
      )}

      {/* Footer: total progress while anything is in flight. */}
      {activeCount > 0 && (
        <div className="flex items-center gap-2.5 border-t border-[var(--line)] px-3.5 py-2">
          <span className="shrink-0 text-[11px] font-medium text-[var(--mut)]">
            {activeAll.length > 0 ? `${activeAll.length} transferring` : `${activeCount} queued`}
          </span>
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--soft)]">
            <div className="h-full rounded-full bg-[var(--dl)] transition-[width]" style={{ width: `${totalPct}%` }} />
          </div>
          <span className="tnum shrink-0 text-[10.5px] text-[var(--faint)]">{totalSpeed > 0 ? formatSpeed(totalSpeed) : `${totalPct}%`}</span>
        </div>
      )}
    </div>
  );
}
