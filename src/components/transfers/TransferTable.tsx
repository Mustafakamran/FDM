import { memo, useState } from "react";
import { Pause, Play, X, AlertCircle } from "lucide-react";
import { formatBytes, formatSpeed, formatEta } from "../../lib/format";
import { fileType } from "../../lib/file-types";
import { SpeedGraph } from "../ui/SpeedGraph";
import type { TransferRow, TransferState } from "./row";

/** Per-job stats the info panel can show when available (downloads only). */
export interface RowStats {
  startedAt?: number;
  peakSpeed?: number;
  minSpeed?: number;
}

interface TransferTableProps {
  rows: TransferRow[];
  kind: "download" | "upload";
  /** Live speed samples per jobId, for the info-panel graph. */
  speedHistory?: Record<number, number[]>;
  statsFor?: (jobId: number) => RowStats | undefined;
  onPause?: (jobId: number) => void;
  onCancel?: (jobId: number) => void;
  onResumeQueued?: (queueId: string) => void;
  onRemoveQueued?: (queueId: string) => void;
  onDismiss?: (jobId: number) => void;
  onResumeFailed?: (row: TransferRow) => void;
}

// Shared grid so the header and every row line up. Columns:
// #  Name  Size  Status  Speed  ETA  Source  Actions
const COLS = "28px minmax(0,1fr) 84px 188px 92px 78px minmax(120px,168px) 66px";

const STATE_COLOR: Record<TransferState, string> = {
  downloading: "var(--dl)",
  uploading: "var(--dl)",
  queued: "var(--faint)",
  paused: "var(--faint)",
  gated: "var(--faint)",
  completed: "var(--ok)",
  failed: "var(--err)",
  cancelled: "var(--faint)",
};

function stateLabel(r: TransferRow): string {
  switch (r.state) {
    case "downloading": return `Downloading ${r.pct}%`;
    case "uploading": return `Uploading ${r.pct}%`;
    case "queued": return "Queued";
    case "paused": return `Paused ${r.pct}%`;
    case "gated": return "Waiting…";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

/** uTorrent-style status cell: translucent progress fill with centred label. */
function StatusCell({ row }: { row: TransferRow }) {
  const color = STATE_COLOR[row.state];
  const fill = row.state === "completed" ? 100 : row.pct;
  return (
    <div className="relative h-[16px] w-full overflow-hidden rounded-[5px] bg-[var(--soft)]">
      <div
        className="absolute inset-y-0 left-0 transition-[width] duration-300"
        style={{ width: `${fill}%`, background: color, opacity: 0.26 }}
      />
      <div className="absolute inset-0 flex items-center justify-center whitespace-nowrap text-[10.5px] font-semibold" style={{ color }}>
        {stateLabel(row)}
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={title}
      data-tip={title}
      className={`flex h-[24px] w-[24px] items-center justify-center rounded-[7px] text-[var(--faint)] hover:bg-[var(--soft)] ${danger ? "hover:text-[var(--err)]" : "hover:text-[var(--ink)]"}`}
    >
      {children}
    </button>
  );
}

const Row = memo(function Row({
  row, index, selected, onSelect, actions,
}: {
  row: TransferRow;
  index: number;
  selected: boolean;
  onSelect: () => void;
  actions: Pick<TransferTableProps, "onPause" | "onCancel" | "onResumeQueued" | "onRemoveQueued" | "onDismiss" | "onResumeFailed">;
}) {
  const ft = fileType(row.name, false);
  const active = row.state === "downloading" || row.state === "uploading";
  const when = row.at ? new Date(row.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : row.source;
  return (
    <div
      role="row"
      onClick={onSelect}
      className={`group grid cursor-pointer items-center gap-2 border-b border-[var(--line)] px-4 py-[7px] text-[12px] transition-colors ${selected ? "bg-[var(--accw)]" : "hover:bg-[var(--soft)]"}`}
      style={{ gridTemplateColumns: COLS }}
    >
      <span className="tnum text-right text-[11px] text-[var(--faint)]">{index + 1}</span>

      <span className="flex min-w-0 items-center gap-2">
        <ft.Icon size={15} style={{ color: ft.color }} className="shrink-0" />
        <span className="truncate font-medium text-[var(--ink)]" data-tip={row.name}>{row.name}</span>
      </span>

      <span className="tnum text-right text-[var(--mut)]">{formatBytes(row.size)}</span>

      <StatusCell row={row} />

      <span className="tnum text-right" style={{ color: active && row.speed > 0 ? "var(--dl)" : "var(--faint)" }}>
        {active ? formatSpeed(row.speed) : "·"}
      </span>

      <span className="tnum text-right text-[var(--faint)]">{active ? formatEta(row.eta) : "·"}</span>

      <span className="truncate text-right text-[11px] text-[var(--faint)]" data-tip={row.error || row.dest || when}>
        {row.state === "failed" && row.error ? <span className="text-[var(--err)]">{row.error}</span> : when}
      </span>

      <span className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {row.jobId != null && active && actions.onPause && (
          <IconBtn title="Pause" onClick={() => actions.onPause!(row.jobId!)}><Pause size={13} /></IconBtn>
        )}
        {row.jobId != null && active && actions.onCancel && (
          <IconBtn title="Cancel" danger onClick={() => actions.onCancel!(row.jobId!)}><X size={13} /></IconBtn>
        )}
        {row.queueId && row.state === "paused" && actions.onResumeQueued && (
          <IconBtn title="Resume" onClick={() => actions.onResumeQueued!(row.queueId!)}><Play size={13} /></IconBtn>
        )}
        {row.queueId && actions.onRemoveQueued && (
          <IconBtn title="Remove" danger onClick={() => actions.onRemoveQueued!(row.queueId!)}><X size={13} /></IconBtn>
        )}
        {row.state === "failed" && row.item && actions.onResumeFailed && (
          <IconBtn title="Resume" onClick={() => actions.onResumeFailed!(row)}><Play size={13} /></IconBtn>
        )}
        {!row.queueId && !active && row.jobId != null && actions.onDismiss && (
          <IconBtn title="Dismiss" onClick={() => actions.onDismiss!(row.jobId!)}><X size={13} /></IconBtn>
        )}
      </span>
    </div>
  );
});

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[var(--faint)]">{label}</div>
      <div className="tnum truncate text-[12.5px] font-medium" style={{ color: color ?? "var(--ink)" }} data-tip={typeof value === "string" ? value : undefined}>{value}</div>
    </div>
  );
}

/** Bottom "Info" panel for the selected transfer — the torrent-client detail. */
function InfoPanel({ row, samples, stats }: { row: TransferRow; samples: number[]; stats?: RowStats }) {
  const ft = fileType(row.name, false);
  const color = STATE_COLOR[row.state];
  const active = row.state === "downloading" || row.state === "uploading";
  const remaining = Math.max(0, row.size - row.bytes);
  const elapsedMs = stats?.startedAt ? Date.now() - stats.startedAt : undefined;
  const avg = elapsedMs && elapsedMs > 0 ? (row.bytes / (elapsedMs / 1000)) : undefined;
  return (
    <div className="flex min-h-0 flex-col border-t border-[var(--line)] bg-[var(--card)]">
      <div className="flex items-center gap-2 px-5 pt-3">
        <ft.Icon size={16} style={{ color: ft.color }} className="shrink-0" />
        <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{row.name}</span>
        <span className="ml-1 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color, background: "var(--soft)" }}>{stateLabel(row)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-4 pt-3">
        {active && samples.length > 1 && (
          <div className="mb-3 h-12">
            <SpeedGraph samples={samples} height={48} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Progress" value={`${row.state === "completed" ? 100 : row.pct}%`} color={color} />
          <Stat label="Size" value={formatBytes(row.size)} />
          <Stat label="Downloaded" value={formatBytes(row.bytes)} />
          <Stat label="Remaining" value={active ? formatBytes(remaining) : "·"} />
          <Stat label="Speed" value={active ? formatSpeed(row.speed) : "·"} color={active && row.speed > 0 ? "var(--dl)" : undefined} />
          <Stat label="ETA" value={active ? formatEta(row.eta) : "·"} />
          <Stat label="Avg speed" value={avg ? formatSpeed(avg) : "·"} />
          <Stat label="Peak speed" value={stats?.peakSpeed ? formatSpeed(stats.peakSpeed) : "·"} />
          <Stat label="Elapsed" value={elapsedMs != null ? fmtDur(elapsedMs) : "·"} />
          <Stat label="Source" value={row.source} />
          <Stat label="Destination" value={row.dest || "·"} />
          {row.at && <Stat label="Finished" value={new Date(row.at).toLocaleString()} />}
        </div>
        {row.error && (
          <div className="mt-3 flex items-start gap-2 rounded-[9px] border border-[var(--line)] bg-[var(--soft)] p-2.5 text-[11.5px] text-[var(--err)]">
            <AlertCircle size={13} className="mt-0.5 shrink-0" /> <span className="min-w-0">{row.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function TransferTable({ rows, kind, speedHistory, statsFor, ...actions }: TransferTableProps) {
  const [sel, setSel] = useState<string | null>(null);
  const selected = sel ? rows.find((r) => r.id === sel) : undefined;
  const speedHeader = kind === "upload" ? "Up Speed" : "Down Speed";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[13px] border border-[var(--line)] bg-[var(--card)]">
      {/* Column header */}
      <div
        className="grid items-center gap-2 border-b border-[var(--line)] bg-[var(--soft)] px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--faint)]"
        style={{ gridTemplateColumns: COLS }}
      >
        <span className="text-right">#</span>
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="pl-1">Status</span>
        <span className="text-right">{speedHeader}</span>
        <span className="text-right">ETA</span>
        <span className="text-right">Source</span>
        <span />
      </div>

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.map((r, i) => (
          <Row
            key={r.id}
            row={r}
            index={i}
            selected={r.id === sel}
            onSelect={() => setSel((cur) => (cur === r.id ? null : r.id))}
            actions={actions}
          />
        ))}
      </div>

      {/* Bottom info panel for the selected row */}
      {selected && (
        <div className="max-h-[46%] min-h-0 shrink-0">
          <InfoPanel
            row={selected}
            samples={(selected.jobId != null && speedHistory?.[selected.jobId]) || []}
            stats={selected.jobId != null ? statsFor?.(selected.jobId) : undefined}
          />
        </div>
      )}
    </div>
  );
}
