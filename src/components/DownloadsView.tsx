import { useMemo } from "react";
import { Download } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp, type DownloadFilter } from "../store/app";
import { useTransfers } from "../store/transfers";
import { useHistory } from "../store/history";
import { laneOf } from "../lib/lane";
import { formatSpeed } from "../lib/format";
import { GeneralDownloads } from "./GeneralDownloads";
import { EmptyState } from "./ui";
import { TransferTable } from "./transfers/TransferTable";
import { jobRow, queueRow, historyRow, type TransferRow, type LabelOf } from "./transfers/row";

const TABS: { key: DownloadFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

export function DownloadsView({ filter }: { filter: DownloadFilter }) {
  // AppShell mounts this view for BOTH the primary Drive/Dropbox transfers and
  // the GENERAL / WEB DOWNLOADS sub-view (they share the "downloads" view kind).
  const web = useApp((s) => (s.view.kind === "downloads" ? s.view.web : false));
  const webCategory = useApp((s) => (s.view.kind === "downloads" ? s.view.category : undefined));
  const webDetail = useApp((s) => (s.view.kind === "downloads" ? s.view.detail : undefined));
  if (web) return <GeneralDownloads filter={webCategory ?? "All"} detail={webDetail} />;

  return <PrimaryDownloads filter={filter} />;
}

function PrimaryDownloads({ filter }: { filter: DownloadFilter }) {
  const showDownloads = useApp((s) => s.showDownloads);
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const inflight = useTransfers((s) => s.inflight);
  const speedHistory = useTransfers((s) => s.speedHistory);
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
  const accounts = useApp((s) => s.accounts);
  const labelOf = useMemo<LabelOf>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a.label]));
    return (id: string) => byId.get(id) ?? id;
  }, [accounts]);

  // Primary (Drive/Dropbox) lane only; web downloads live in GeneralDownloads.
  const primaryJobs = jobs.filter((j) => laneOf(j.accountId) === "primary");
  const primaryQueue = queue.filter((q) => laneOf(q.accountId) === "primary");
  const primaryHistory = history.filter((h) => laneOf(h.accountId) === "primary");

  const active = primaryJobs.filter((j) => !j.finished && !j.cancelled);
  const showActive = filter === "all" || filter === "active";
  const showHistory = filter !== "active";
  const histFiltered = primaryHistory.filter((h) =>
    filter === "completed" ? h.status === "success" : filter === "failed" ? h.status !== "success" : true,
  );
  const totalSpeed = active.reduce((s, j) => s + Math.max(0, j.speed), 0);
  const completedCount = primaryHistory.filter((h) => h.status === "success").length;

  const rows: TransferRow[] = [];
  if (showActive) {
    for (const j of active) rows.push(jobRow(j, labelOf));
    primaryQueue.forEach((q, i) => rows.push(queueRow(q, i + 1, labelOf)));
  }
  if (showHistory) {
    for (const h of histFiltered) rows.push(historyRow(h, labelOf));
  }

  const statsFor = (jobId: number) => inflight.find((i) => i.jobId === jobId)?.stats;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 px-7 pt-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.025em] text-[var(--ink)]">Downloads</h1>
            <p className="mt-1 text-[13px] text-[var(--mut)]">
              {active.length} active · <span className="font-semibold text-[var(--dl)]">{totalSpeed > 0 ? formatSpeed(totalSpeed) : "0 B/s"}</span> total · {completedCount} completed
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

      <div className="flex min-h-0 flex-1 flex-col px-7 pb-6 pt-5">
        {rows.length === 0 ? (
          <EmptyState
            icon={<Download size={20} />}
            title={filter === "failed" ? "No failed downloads" : filter === "completed" ? "No completed downloads yet" : filter === "active" ? "Nothing downloading" : "No downloads yet"}
            body="Select files in a connected account and hit Download, or paste a URL to grab it from the web."
          />
        ) : (
          <TransferTable
            rows={rows}
            kind="download"
            speedHistory={speedHistory}
            statsFor={statsFor}
            onPause={pause}
            onCancel={cancel}
            onResumeQueued={resumePaused}
            onRemoveQueued={removeQueued}
            onResumeFailed={(r) => { if (r.item) { enqueue(r.accountId, [r.item], r.dest); if (r.jobId != null) removeEntry(r.jobId); } }}
          />
        )}
      </div>
    </div>
  );
}
