import { ChevronRight, ChevronLeft, X, Check, AlertCircle, Download, Ban } from "lucide-react";
import { useTransfers } from "../store/transfers";
import { useApp } from "../store/app";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import { ProviderIcon } from "./icons";
import type { JobStatus } from "../lib/tauri/commands";

function pct(j: JobStatus): number {
  if (j.finished && j.success) return 100;
  if (j.totalBytes > 0) return Math.min(100, Math.round((j.bytes / j.totalBytes) * 100));
  return 0;
}

function JobCard({ job }: { job: JobStatus }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === job.accountId));
  const cancel = useTransfers((s) => s.cancel);
  const p = pct(job);

  const state =
    job.cancelled
      ? { label: "Cancelled", color: "var(--text-3)", icon: <Ban size={13} /> }
      : job.finished && job.success
        ? { label: "Done", color: "var(--success)", icon: <Check size={13} /> }
        : job.finished
          ? { label: "Failed", color: "var(--error)", icon: <AlertCircle size={13} /> }
          : { label: formatSpeed(job.speed), color: "var(--accent)", icon: <Download size={13} /> };

  const active = !job.finished && !job.cancelled;

  return (
    <div className="rounded-[6px] border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="mb-1 flex items-center gap-2">
        {account && (
          <span className="text-[var(--text-3)]">
            <ProviderIcon provider={account.provider} size={13} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]" title={job.name}>
          {job.name}
        </span>
        {active && (
          <button
            className="text-[var(--text-3)] hover:text-[var(--error)]"
            onClick={() => cancel(job.jobId)}
            aria-label={`Cancel ${job.name}`}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--hover)]">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${p}%`, backgroundColor: state.color }}
        />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 tnum" style={{ color: state.color }}>
          {state.icon} {state.label}
        </span>
        <span className="tnum text-[var(--text-3)]">
          {job.error ? (
            <span className="text-[var(--error)]" title={job.error}>
              error
            </span>
          ) : active ? (
            <>
              {formatBytes(job.bytes)}
              {job.totalBytes > 0 && ` / ${formatBytes(job.totalBytes)}`} · {formatEta(job.eta)}
            </>
          ) : (
            formatBytes(job.totalBytes || job.bytes)
          )}
        </span>
      </div>
    </div>
  );
}

export function TransfersDock() {
  const { jobs, dockOpen, setDockOpen, clearFinished } = useTransfers();

  const active = jobs.filter((j) => !j.finished && !j.cancelled);
  const totalSpeed = active.reduce((sum, j) => sum + Math.max(0, j.speed), 0);
  const hasFinished = jobs.some((j) => j.finished || j.cancelled);

  if (jobs.length === 0) return null;

  if (!dockOpen) {
    return (
      <button
        className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-[var(--border)] bg-[var(--surface)] py-3 text-[var(--text-2)] hover:text-[var(--text)]"
        onClick={() => setDockOpen(true)}
        aria-label="Open transfers"
      >
        <ChevronLeft size={16} />
        <span className="tnum text-[10px] [writing-mode:vertical-rl]">
          {active.length} · {formatSpeed(totalSpeed)}
        </span>
      </button>
    );
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2.5">
        <span className="text-sm font-semibold text-[var(--text)]">Transfers</span>
        <div className="flex items-center gap-2">
          {hasFinished && (
            <button
              className="text-xs text-[var(--text-3)] hover:text-[var(--text)]"
              onClick={() => clearFinished()}
            >
              Clear done
            </button>
          )}
          <button
            className="text-[var(--text-3)] hover:text-[var(--text)]"
            onClick={() => setDockOpen(false)}
            aria-label="Collapse transfers"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {jobs.map((j) => (
          <JobCard key={j.jobId} job={j} />
        ))}
      </div>

      <div className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)]">
        <span className="tnum">{active.length}</span> active ·{" "}
        <span className="tnum text-[var(--text)]">{formatSpeed(totalSpeed)}</span>
      </div>
    </aside>
  );
}
