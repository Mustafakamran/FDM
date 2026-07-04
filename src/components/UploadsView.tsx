import { useMemo } from "react";
import { X, Upload } from "lucide-react";
import { useApp, type DownloadFilter } from "../store/app";
import { useTransfers } from "../store/transfers";
import { formatBytes, formatSpeed, formatEta } from "../lib/format";
import { EmptyState } from "./ui";
import type { JobStatus } from "../lib/tauri/commands";

type LabelOf = (accountId: string) => string;

const TABS: { key: DownloadFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function pct(u: JobStatus): number {
  if (u.totalBytes > 0) return Math.min(100, Math.round((u.bytes / u.totalBytes) * 100));
  return 0;
}

const ext = (name: string) => (name.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE";

/** Uploads (local → cloud) — a mirror of the Downloads screen. Upload jobs come
 *  through the same poll as downloads (backend `kind: "upload"`), so live
 *  progress / speed / ETA and cancel all work with no extra backend. Uploads
 *  have no queue / pause / resume, so this view is simpler than Downloads. */
export function UploadsView({ filter }: { filter: DownloadFilter }) {
  const showUploads = useApp((s) => s.showUploads);
  const uploads = useTransfers((s) => s.uploads);
  const cancel = useTransfers((s) => s.cancel);
  const dismiss = useTransfers((s) => s.dismissUpload);
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

      <div className="min-h-0 flex-1 overflow-auto px-7 pb-6 pt-5">
        {showActive && active.length > 0 && (
          <div className="mb-6">
            <div className="mb-3 font-mono text-[11px] font-semibold tracking-[0.06em] text-[var(--faint)]">IN PROGRESS</div>
            <div className="flex flex-col gap-3">
              {active.map((u) => (
                <div key={u.jobId} className="rounded-[15px] border border-[var(--line)] bg-[var(--card)] p-4 transition-colors hover:border-[var(--line2)]">
                  <div className="mb-3 flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-[var(--accw)]">
                      <Upload size={16} className="text-[var(--dl)]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold text-[var(--ink)]">{u.name}</div>
                      <div className="truncate text-[11.5px] text-[var(--faint)]">{labelOf(u.accountId)} · {u.dest}</div>
                    </div>
                    <span className="tnum text-[13px] font-semibold text-[var(--dl)]">{u.totalBytes > 0 ? `${pct(u)}%` : formatBytes(u.bytes)}</span>
                    <button onClick={() => cancel(u.jobId)} aria-label={`Cancel ${u.name}`} data-tip="Cancel" className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-[var(--line)] bg-[var(--card)] text-[var(--mut)] hover:border-[var(--err)] hover:bg-[var(--errw)] hover:text-[var(--err)]">
                      <X size={14} />
                    </button>
                  </div>
                  <div className="h-[7px] overflow-hidden rounded-full bg-[var(--soft)]">
                    <div className="h-full rounded-full bg-[var(--dl)] transition-[width] duration-500" style={{ width: u.totalBytes > 0 ? `${pct(u)}%` : "100%" }} />
                  </div>
                  <div className="mt-2 flex justify-between font-mono text-[11.5px] text-[var(--faint)]">
                    <span>{formatBytes(u.bytes)}{u.totalBytes > 0 ? ` of ${formatBytes(u.totalBytes)}` : ""}</span>
                    <span>{u.speed > 0 ? <><span className="text-[var(--dl)]">{formatSpeed(u.speed)}</span> · {formatEta(u.eta)} left</> : "Uploading…"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {showHistory && (
          <div>
            {filter === "all" && finished.length > 0 && <div className="mb-3 font-mono text-[11px] font-semibold tracking-[0.06em] text-[var(--faint)]">HISTORY</div>}
            {histFiltered.length === 0 ? (
              <EmptyState
                icon={<Upload size={20} />}
                title={filter === "failed" ? "No failed uploads" : filter === "completed" ? "No completed uploads yet" : "No uploads yet"}
                body="Open a drive folder and use the Upload button to send local files or folders to the cloud."
              />
            ) : (
              <div className="overflow-hidden rounded-[15px] border border-[var(--line)] bg-[var(--card)]">
                {histFiltered.map((u) => {
                  const badge = u.success
                    ? { color: "var(--ok)", label: "Completed" }
                    : u.cancelled
                      ? { color: "var(--faint)", label: "Cancelled" }
                      : { color: "var(--err)", label: "Failed" };
                  return (
                    <div key={u.jobId} className="flex items-center gap-3 border-b border-[var(--line)] px-[18px] py-3 last:border-b-0">
                      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--accw)] font-mono text-[9px] font-semibold text-[var(--mut)]">{ext(u.name)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-[var(--ink)]" data-tip={u.name}>{u.name}</div>
                        {!u.success && !u.cancelled && u.error ? (
                          <div className="truncate text-[11.5px] text-[var(--err)]" data-tip={u.error}>{u.error}</div>
                        ) : (
                          <div className="truncate text-[11.5px] text-[var(--faint)]" data-tip={u.dest}>{labelOf(u.accountId)} · {u.dest}</div>
                        )}
                      </div>
                      <span className="tnum w-[74px] shrink-0 text-right font-mono text-[12.5px] text-[var(--mut)]">{formatBytes(u.totalBytes || u.bytes)}</span>
                      <span className="flex w-[130px] shrink-0 items-center justify-end gap-1.5 text-[11.5px] font-semibold" style={{ color: badge.color }}>
                        <span className="h-[7px] w-[7px] rounded-full" style={{ background: badge.color }} /> {badge.label}
                      </span>
                      <button onClick={() => dismiss(u.jobId)} aria-label={`Dismiss ${u.name}`} data-tip="Dismiss" className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] text-[var(--faint)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
                        <X size={13} />
                      </button>
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
