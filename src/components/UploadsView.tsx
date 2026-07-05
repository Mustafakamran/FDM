import { useMemo } from "react";
import { Upload } from "lucide-react";
import { useApp, type DownloadFilter } from "../store/app";
import { useTransfers } from "../store/transfers";
import { formatSpeed } from "../lib/format";
import { EmptyState } from "./ui";
import { TransferTable } from "./transfers/TransferTable";
import { jobRow, uploadHistoryRow, type TransferRow, type LabelOf } from "./transfers/row";

const TABS: { key: DownloadFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

/** Uploads (local → cloud) — a mirror of the Downloads screen using the same
 *  torrent-style table. Upload jobs come through the same poll (backend
 *  `kind: "upload"`), so live progress / speed / ETA / cancel all work with no
 *  extra backend. Uploads have no queue / pause / resume. */
export function UploadsView({ filter }: { filter: DownloadFilter }) {
  const showUploads = useApp((s) => s.showUploads);
  const uploads = useTransfers((s) => s.uploads);
  const cancel = useTransfers((s) => s.cancel);
  const dismiss = useTransfers((s) => s.dismissUpload);
  const speedHistory = useTransfers((s) => s.speedHistory);
  const accounts = useApp((s) => s.accounts);
  const labelOf = useMemo<LabelOf>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a.label]));
    return (id: string) => byId.get(id) ?? id;
  }, [accounts]);

  const active = uploads.filter((u) => !u.finished && !u.cancelled);
  const finished = uploads.filter((u) => u.finished || u.cancelled);
  const histFiltered = finished.filter((u) =>
    filter === "completed" ? u.success : filter === "failed" ? !u.success : true,
  );
  const showActive = filter === "all" || filter === "active";
  const showHistory = filter !== "active";
  const totalSpeed = active.reduce((s, u) => s + Math.max(0, u.speed), 0);
  const completedCount = finished.filter((u) => u.success).length;

  const rows: TransferRow[] = [];
  if (showActive) for (const u of active) rows.push(jobRow(u, labelOf));
  if (showHistory) for (const u of histFiltered) rows.push(uploadHistoryRow(u, labelOf));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 px-7 pt-6">
        <h1 className="text-[24px] font-bold tracking-[-0.025em] text-[var(--ink)]">Uploads</h1>
        <p className="mt-1 text-[13px] text-[var(--mut)]">
          {active.length} active · <span className="font-semibold text-[var(--dl)]">{totalSpeed > 0 ? formatSpeed(totalSpeed) : "0 B/s"}</span> total · {completedCount} completed
        </p>
        <div className="mt-[18px] flex items-center gap-1.5">
          {TABS.map((t) => {
            const on = filter === t.key;
            return (
              <button
                key={t.key}
                onClick={() => showUploads(t.key)}
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
            icon={<Upload size={20} />}
            title={filter === "failed" ? "No failed uploads" : filter === "completed" ? "No completed uploads yet" : filter === "active" ? "Nothing uploading" : "No uploads yet"}
            body="Open a drive folder and use the Upload button to send local files or folders to the cloud."
          />
        ) : (
          <TransferTable
            rows={rows}
            kind="upload"
            speedHistory={speedHistory}
            onCancel={cancel}
            onDismiss={dismiss}
          />
        )}
      </div>
    </div>
  );
}
