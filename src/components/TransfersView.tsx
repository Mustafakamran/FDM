import { useMemo } from "react";
import { ArrowDownUp } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp, type TransferFilter } from "../store/app";
import { useTransfers } from "../store/transfers";
import { useHistory } from "../store/history";
import { formatSpeed } from "../lib/format";
import { openInFileManager, deleteDownloadFiles } from "../lib/tauri/commands";
import { EmptyState } from "./ui";
import { UrlDownload } from "./UrlDownload";
import { TransferTable } from "./transfers/TransferTable";
import { jobRow, queueRow, historyRow, uploadHistoryRow, type TransferRow, type LabelOf } from "./transfers/row";

const FILTERS: { key: TransferFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "downloading", label: "Downloading" },
  { key: "uploading", label: "Uploading" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

/**
 * The unified Transfers screen: every download (Drive / Dropbox / web / torrent)
 * AND every upload in one torrent-style table, filtered by direction/state.
 * Replaces the separate Downloads, Web Downloads, and Uploads views.
 */
export function TransfersView({ filter }: { filter: TransferFilter }) {
  const showTransfers = useApp((s) => s.showTransfers);
  const setView = useApp((s) => s.setView);
  const accounts = useApp((s) => s.accounts);
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const uploads = useTransfers((s) => s.uploads);
  const inflight = useTransfers((s) => s.inflight);
  const speedHistory = useTransfers((s) => s.speedHistory);
  const { cancel, pause, resumePaused, removeQueued, forceStart, deleteJob, enqueue, dismissUpload } = useTransfers(
    useShallow((s) => ({
      cancel: s.cancel,
      pause: s.pause,
      resumePaused: s.resumePaused,
      removeQueued: s.removeQueued,
      forceStart: s.forceStart,
      deleteJob: s.deleteJob,
      enqueue: s.enqueue,
      dismissUpload: s.dismissUpload,
    })),
  );
  const history = useHistory((s) => s.items);
  const clearHistory = useHistory((s) => s.clear);
  const removeEntry = useHistory((s) => s.removeEntry);

  const labelOf = useMemo<LabelOf>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a.label]));
    return (id: string) => byId.get(id) ?? id;
  }, [accounts]);

  // Split the raw state into direction/state buckets.
  const dlActive = jobs.filter((j) => !j.finished && !j.cancelled);
  const upActive = uploads.filter((u) => !u.finished && !u.cancelled);
  const upFinished = uploads.filter((u) => u.finished || u.cancelled);

  const activeCount = dlActive.length + upActive.length + queue.filter((q) => !q.paused).length;
  const totalSpeed =
    dlActive.reduce((s, j) => s + Math.max(0, j.speed), 0) +
    upActive.reduce((s, u) => s + Math.max(0, u.speed), 0);
  const completedCount = history.filter((h) => h.status === "success").length + upFinished.filter((u) => u.success).length;
  const hasHistory = history.length > 0 || upFinished.length > 0;

  const rows: TransferRow[] = [];
  const showDl = filter === "all" || filter === "downloading";
  const showUp = filter === "all" || filter === "uploading";
  const showCompleted = filter === "all" || filter === "completed";
  const showFailed = filter === "all" || filter === "failed";
  const itemByJob = new Map(inflight.map((i) => [i.jobId, i.item]));
  if (showDl) {
    for (const j of dlActive) rows.push(jobRow(j, labelOf, itemByJob.get(j.jobId)));
    queue.forEach((q, i) => rows.push(queueRow(q, i + 1, labelOf)));
  }
  if (showUp) {
    for (const u of upActive) rows.push(jobRow(u, labelOf));
  }
  if (showCompleted || showFailed) {
    for (const h of history) {
      const ok = h.status === "success";
      if ((ok && showCompleted) || (!ok && showFailed)) rows.push(historyRow(h, labelOf));
    }
    for (const u of upFinished) {
      if ((u.success && showCompleted) || (!u.success && showFailed)) rows.push(uploadHistoryRow(u, labelOf));
    }
  }

  const statsFor = (jobId: number) => inflight.find((i) => i.jobId === jobId)?.stats;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 px-7 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.025em] text-[var(--ink)]">Transfers</h1>
            <p className="mt-1 text-[13px] text-[var(--mut)]">
              {activeCount} active · <span className="font-semibold text-[var(--dl)]">{totalSpeed > 0 ? formatSpeed(totalSpeed) : "0 B/s"}</span> total · {completedCount} completed
            </p>
          </div>
          <div className="flex items-center gap-3">
            {hasHistory && (
              <button onClick={() => clearHistory()} className="text-xs font-medium text-[var(--faint)] hover:text-[var(--ink)]">Clear history</button>
            )}
            <UrlDownload />
          </div>
        </div>
        <div className="mt-[18px] flex items-center gap-1.5">
          {FILTERS.map((t) => {
            const on = filter === t.key;
            return (
              <button
                key={t.key}
                onClick={() => showTransfers(t.key)}
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

      <div className="flex min-h-0 flex-1 flex-col px-7 pb-6 pt-5">
        {rows.length === 0 ? (
          <EmptyState
            icon={<ArrowDownUp size={20} />}
            title={
              filter === "failed" ? "No failed transfers"
              : filter === "completed" ? "No completed transfers yet"
              : filter === "uploading" ? "Nothing uploading"
              : filter === "downloading" ? "Nothing downloading"
              : "No transfers yet"
            }
            body="Select files in a connected account and hit Download, upload local files to a drive, or add a URL / magnet / .torrent."
          />
        ) : (
          <TransferTable
            rows={rows}
            speedHistory={speedHistory}
            statsFor={statsFor}
            onPause={pause}
            onCancel={cancel}
            onResumeQueued={resumePaused}
            onRemoveQueued={removeQueued}
            onForceStart={forceStart}
            onResumeFailed={(r) => { if (r.item) { enqueue(r.accountId, [r.item], r.dest); if (r.jobId != null) removeEntry(r.jobId); } }}
            onGoToSource={(r) => {
              const parent = r.source.includes("/") ? r.source.split("/").slice(0, -1).join("/") : "";
              setView({ kind: "browse", accountId: r.accountId, section: "all", path: parent });
            }}
            onOpenDest={(r) => { void openInFileManager(r.dest); }}
            onDelete={async (r, withFiles) => {
              if (r.queueId) removeQueued(r.queueId);
              else if (r.jobId != null) { if (r.upload) dismissUpload(r.jobId); else await deleteJob(r.jobId); }
              if (withFiles && !r.upload && r.name) {
                try { await deleteDownloadFiles(r.dest, r.name); } catch { /* file may already be gone */ }
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
