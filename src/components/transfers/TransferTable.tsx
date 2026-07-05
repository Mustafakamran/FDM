import { memo, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, X, Square, Zap, Trash2, RotateCcw, Copy, FolderOpen, FolderSymlink, AlertCircle } from "lucide-react";
import { formatBytes, formatSpeed, formatEta } from "../../lib/format";
import { laneOf } from "../../lib/lane";
import { fileType } from "../../lib/file-types";
import { SpeedGraph } from "../ui/SpeedGraph";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import type { TransferRow, TransferState } from "./row";

/** Per-job stats the info panel can show when available (downloads only). */
export interface RowStats {
  startedAt?: number;
  peakSpeed?: number;
  minSpeed?: number;
}

interface TransferTableProps {
  rows: TransferRow[];
  /** Live speed samples per jobId, for the info-panel graph. */
  speedHistory?: Record<number, number[]>;
  statsFor?: (jobId: number) => RowStats | undefined;
  onPause?: (jobId: number) => void;
  onCancel?: (jobId: number) => void;
  onResumeQueued?: (queueId: string) => void;
  onRemoveQueued?: (queueId: string) => void;
  onForceStart?: (queueId: string) => void;
  onResumeFailed?: (row: TransferRow) => void;
  /** Navigate the app to the source folder (Drive/Dropbox downloads). */
  onGoToSource?: (row: TransferRow) => void;
  /** Open the local destination folder in the OS file manager. */
  onOpenDest?: (row: TransferRow) => void;
  /** Remove the transfer; `withFiles` also deletes its files from disk. */
  onDelete?: (row: TransferRow, withFiles: boolean) => void;
}

type RowActions = Omit<TransferTableProps, "rows" | "speedHistory" | "statsFor">;

/** Right-click menu items for a row, based on its state. `onRequestDelete` opens
 *  the confirm dialog (list-only vs list + files). */
function buildMenu(row: TransferRow, a: RowActions, onRequestDelete: (r: TransferRow) => void): MenuItem[] {
  const items: MenuItem[] = [];
  const active = row.state === "downloading" || row.state === "uploading";
  const done = row.state === "completed" || row.state === "failed" || row.state === "cancelled";
  const copy = (t: string) => { if (t) void navigator.clipboard?.writeText(t).catch(() => {}); };

  if (active && row.jobId != null) {
    if (a.onPause && !row.upload) items.push({ label: "Pause", icon: Pause, onClick: () => a.onPause!(row.jobId!) });
    if (a.onCancel) items.push({ label: "Stop", icon: Square, danger: true, onClick: () => a.onCancel!(row.jobId!) });
  }
  if (row.queueId) {
    if (a.onForceStart) items.push({ label: "Force download now", icon: Zap, onClick: () => a.onForceStart!(row.queueId!) });
    if (row.state === "paused" && a.onResumeQueued) items.push({ label: "Resume", icon: Play, onClick: () => a.onResumeQueued!(row.queueId!) });
  }
  if (done && row.item && a.onResumeFailed) {
    items.push({ label: row.state === "failed" ? "Retry" : "Download again", icon: RotateCcw, onClick: () => a.onResumeFailed!(row) });
  }
  // Navigate to source (in-app, Drive/Dropbox only) and open the local
  // destination in the OS file manager.
  const primary = !row.upload && laneOf(row.accountId) === "primary";
  if (a.onGoToSource && primary) items.push({ label: "Go to source folder", icon: FolderSymlink, separator: items.length > 0, onClick: () => a.onGoToSource!(row) });
  if (a.onOpenDest && !row.upload && row.dest) items.push({ label: "Open destination folder", icon: FolderOpen, separator: items.length > 0 && !primary, onClick: () => a.onOpenDest!(row) });
  items.push({ label: "Copy source", icon: Copy, separator: true, onClick: () => copy(row.source) });
  items.push({ label: "Copy destination", icon: Copy, onClick: () => copy(row.dest) });
  if (a.onDelete) items.push({ label: "Delete…", icon: Trash2, danger: true, separator: true, onClick: () => onRequestDelete(row) });
  return items;
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
  row, index, selected, onSelect, onContext, onRequestDelete, actions,
}: {
  row: TransferRow;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onContext: (e: React.MouseEvent) => void;
  onRequestDelete: (row: TransferRow) => void;
  actions: RowActions;
}) {
  const ft = fileType(row.name, false);
  const active = row.state === "downloading" || row.state === "uploading";
  const when = row.at ? new Date(row.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : row.source;
  return (
    <div
      role="row"
      onClick={onSelect}
      onContextMenu={onContext}
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
        {!row.queueId && !active && row.jobId != null && actions.onDelete && (
          <IconBtn title="Delete" danger onClick={() => onRequestDelete(row)}><X size={13} /></IconBtn>
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
          <Stat label="Account" value={row.account} />
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

/** Confirm dialog: remove from the list only, or also delete files from disk. */
function DeleteDialog({ row, onClose, onConfirm }: { row: TransferRow; onClose: () => void; onConfirm: (withFiles: boolean) => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div className="animate-pop w-[420px] max-w-full rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-5 shadow-[var(--shadow-lg)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Trash2 size={16} className="text-[var(--err)]" />
          <h2 className="text-[15px] font-semibold text-[var(--ink)]">Delete transfer</h2>
        </div>
        <p className="mt-2 truncate text-[13px] font-medium text-[var(--ink)]" data-tip={row.name}>{row.name}</p>
        <p className="mt-1 text-[12.5px] text-[var(--faint)]">Remove it from the list only, or also delete the downloaded files from disk? Deleting files can’t be undone.</p>
        <div className="mt-4 flex flex-col gap-2">
          <button onClick={() => onConfirm(false)} className="w-full rounded-[9px] border border-[var(--line)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)] hover:bg-[var(--soft)]">
            Remove from list
          </button>
          {!row.upload && (
            <button onClick={() => onConfirm(true)} className="w-full rounded-[9px] border border-[var(--err)] bg-[var(--errw)] px-3 py-2 text-[13px] font-semibold text-[var(--err)] hover:opacity-90">
              Delete from list and files
            </button>
          )}
          <button onClick={onClose} className="w-full rounded-[9px] px-3 py-2 text-[13px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function TransferTable({ rows, speedHistory, statsFor, ...actions }: TransferTableProps) {
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: TransferRow } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TransferRow | null>(null);
  const selected = sel ? rows.find((r) => r.id === sel) : undefined;
  const openMenu = (e: React.MouseEvent, r: TransferRow) => {
    e.preventDefault();
    setSel(r.id);
    setMenu({ x: e.clientX, y: e.clientY, row: r });
  };

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
        <span className="text-right">Speed</span>
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
            onContext={(e) => openMenu(e, r)}
            onRequestDelete={setPendingDelete}
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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.row, actions, (r) => setPendingDelete(r))} onClose={() => setMenu(null)} />
      )}

      {pendingDelete && (
        <DeleteDialog
          row={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={(withFiles) => { actions.onDelete?.(pendingDelete, withFiles); setPendingDelete(null); }}
        />
      )}
    </div>
  );
}
