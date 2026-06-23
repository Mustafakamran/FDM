import {
  ArrowLeft,
  Check,
  AlertCircle,
  Ban,
  Loader2,
  Calendar,
  Timer,
  Gauge,
  FolderDown,
  Link as LinkIcon,
  HardDrive,
} from "lucide-react";
import { useApp } from "../store/app";
import { useHistory, type HistoryEntry } from "../store/history";
import { useTransfers } from "../store/transfers";
import { categoryFor, type Category } from "../lib/categories";
import { fileType } from "../lib/file-types";
import { formatBytes, formatSpeed } from "../lib/format";
import type { JobStatus } from "../lib/tauri/commands";

/** ms → "1h 02m 03s", "3m 20s", "12s", "<1s", or "—". */
export function formatDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  if (total < 1) return "<1s";
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

interface StatusBadge {
  Icon: typeof Check;
  color: string;
  label: string;
}

function statusBadge(status: "active" | "success" | "failed" | "cancelled"): StatusBadge {
  switch (status) {
    case "active":
      return { Icon: Loader2, color: "var(--accent)", label: "Downloading" };
    case "success":
      return { Icon: Check, color: "var(--success)", label: "Completed" };
    case "cancelled":
      return { Icon: Ban, color: "var(--text-3)", label: "Cancelled" };
    case "failed":
      return { Icon: AlertCircle, color: "var(--error)", label: "Failed" };
  }
}

/** One label/value row. */
function Field({
  Icon,
  label,
  value,
  title,
  mono,
}: {
  Icon: typeof Check;
  label: string;
  value: React.ReactNode;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-[var(--border)]/60 py-3">
      <Icon size={16} className="mt-0.5 shrink-0 text-[var(--text-3)]" />
      <div className="w-32 shrink-0 text-xs font-medium uppercase tracking-wide text-[var(--text-3)]">
        {label}
      </div>
      <div
        className={`min-w-0 flex-1 break-words text-sm text-[var(--text)] ${mono ? "tnum" : ""}`}
        title={title}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Normalized shape the detail panel renders, derived from either a live job or
 * a finished history entry.
 */
interface Detail {
  name: string;
  category: Category;
  size: number;
  status: "active" | "success" | "failed" | "cancelled";
  dest: string;
  sourceUrl?: string;
  error?: string;
  startedAt?: number;
  durationMs?: number;
  maxSpeed?: number;
  minSpeed?: number;
  avgSpeed?: number;
}

function fromJob(j: JobStatus): Detail {
  return {
    name: j.name,
    category: categoryFor(j.name),
    size: j.totalBytes || j.bytes,
    status: "active",
    dest: j.dest,
    maxSpeed: j.speed > 0 ? j.speed : undefined,
  };
}

function fromHistory(h: HistoryEntry): Detail {
  return {
    name: h.name,
    category: h.category ?? categoryFor(h.name),
    size: h.size,
    status: h.status,
    dest: h.dest,
    sourceUrl: h.sourceUrl,
    error: h.error,
    startedAt: h.startedAt,
    durationMs: h.durationMs,
    maxSpeed: h.maxSpeed,
    minSpeed: h.minSpeed,
    avgSpeed: h.avgSpeed,
  };
}

/**
 * Per-download detail panel for the GENERAL DOWNLOADS view. Resolves the pinned
 * id (`view.detail`) against the live job list first (active download), then the
 * persisted history. `j<jobId>` is the canonical id form for both lanes.
 */
export function DownloadDetail({ id }: { id: string }) {
  const back = useApp((s) => s.openWebDownloadDetail);
  const jobs = useTransfers((s) => s.jobs);
  const history = useHistory((s) => s.items);

  const jobId = id.startsWith("j") ? Number(id.slice(1)) : Number(id);
  const liveJob = jobs.find((j) => j.jobId === jobId && !j.finished && !j.cancelled);
  const histEntry = history.find((h) => h.jobId === jobId);

  const detail = liveJob ? fromJob(liveJob) : histEntry ? fromHistory(histEntry) : null;

  if (!detail) {
    return (
      <div className="flex h-full flex-col">
        <Header onBack={() => back(undefined)} title="Download" />
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-3)]">
          This download is no longer available.
        </div>
      </div>
    );
  }

  const badge = statusBadge(detail.status);
  const ft = fileType(detail.name, false);

  return (
    <div className="flex h-full flex-col">
      <Header onBack={() => back(undefined)} title="Download details" />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div className="mb-4 flex items-center gap-3">
          <ft.Icon size={28} style={{ color: ft.color }} className="shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-[var(--text)]" title={detail.name}>
              {detail.name}
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 text-xs font-medium"
                style={{ color: badge.color }}
              >
                <badge.Icon size={13} className={detail.status === "active" ? "animate-spin" : ""} />
                {badge.label}
              </span>
              <span className="inline-flex items-center rounded-full bg-[var(--hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-2)]">
                {detail.category}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-4">
          <Field Icon={HardDrive} label="Size" value={formatBytes(detail.size)} mono />
          <Field
            Icon={Calendar}
            label="Started"
            value={detail.startedAt ? new Date(detail.startedAt).toLocaleString() : "—"}
            mono
          />
          <Field Icon={Timer} label="Duration" value={formatDuration(detail.durationMs)} mono />
          <Field
            Icon={Gauge}
            label="Avg speed"
            value={detail.avgSpeed ? formatSpeed(detail.avgSpeed) : "—"}
            mono
          />
          <Field
            Icon={Gauge}
            label="Max speed"
            value={detail.maxSpeed ? formatSpeed(detail.maxSpeed) : "—"}
            mono
          />
          <Field
            Icon={Gauge}
            label="Min speed"
            value={detail.minSpeed ? formatSpeed(detail.minSpeed) : "—"}
            mono
          />
          <Field
            Icon={LinkIcon}
            label="Source"
            value={
              detail.sourceUrl ? (
                <span className="break-all">{detail.sourceUrl}</span>
              ) : (
                <span className="text-[var(--text-3)]">—</span>
              )
            }
            title={detail.sourceUrl}
          />
          <Field
            Icon={FolderDown}
            label="Destination"
            value={<span className="break-all">{detail.dest}</span>}
            title={detail.dest}
          />
          {detail.error && (
            <Field
              Icon={AlertCircle}
              label="Error"
              value={<span className="text-[var(--error)]">{detail.error}</span>}
              title={detail.error}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="flex items-center gap-2 px-6 pt-6 pb-2">
      <button
        onClick={onBack}
        aria-label="Back to web downloads"
        title="Back"
        className="flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <ArrowLeft size={16} />
      </button>
      <h1 className="text-lg font-semibold text-[var(--text)]">{title}</h1>
    </div>
  );
}
