// Unified row model for the torrent-style transfer table. Active jobs, queued
// items, and history entries all collapse to one `TransferRow` shape so a single
// table can list every transfer regardless of state (like a torrent client).

import type { JobStatus, DownloadItem } from "../../lib/tauri/commands";
import type { QueueItem } from "../../store/transfers";
import type { HistoryEntry } from "../../store/history";

export type TransferState =
  | "downloading"
  | "uploading"
  | "queued"
  | "paused"
  | "gated"
  | "completed"
  | "failed"
  | "cancelled";

export interface TransferRow {
  /** Stable per-row id (job/queue/history keyed) for React + selection. */
  id: string;
  jobId?: number;
  queueId?: string;
  name: string;
  /** Best-known total size in bytes. */
  size: number;
  bytes: number;
  speed: number;
  eta: number | null;
  /** 0..100. */
  pct: number;
  state: TransferState;
  accountId: string;
  dest: string;
  /** Human label (account name / "Web"), resolved by the caller. */
  source: string;
  error?: string;
  /** Finished-at timestamp (history rows). */
  at?: number;
  /** Present on failed rows so the panel/actions can re-enqueue. */
  item?: DownloadItem;
}

export type LabelOf = (accountId: string) => string;

const jobPct = (bytes: number, total: number) =>
  total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0;

/** A live download/upload job. */
export function jobRow(j: JobStatus, labelOf: LabelOf): TransferRow {
  return {
    id: `j${j.jobId}`,
    jobId: j.jobId,
    name: j.name,
    size: j.totalBytes || j.bytes,
    bytes: j.bytes,
    speed: j.speed,
    eta: j.eta,
    pct: jobPct(j.bytes, j.totalBytes),
    state: j.kind === "upload" ? "uploading" : "downloading",
    accountId: j.accountId,
    dest: j.dest,
    source: labelOf(j.accountId),
  };
}

/** A queued (not-yet-started) download. `gated` = waiting on the primary lane. */
export function queueRow(q: QueueItem, position: number, labelOf: LabelOf): TransferRow {
  const gated = !!q.autoPaused && !q.paused;
  return {
    id: q.id,
    queueId: q.id,
    name: q.item.name,
    size: q.item.size ?? 0,
    bytes: q.resumedBytes ?? 0,
    speed: 0,
    eta: null,
    pct: q.item.size ? jobPct(q.resumedBytes ?? 0, q.item.size) : 0,
    state: gated ? "gated" : q.paused ? "paused" : "queued",
    accountId: q.accountId,
    dest: q.dest,
    // Position hint next to the account so the queue order is visible.
    source: `${labelOf(q.accountId)} · #${position}`,
    item: q.item,
  };
}

/** A finished/failed/cancelled transfer from history. */
export function historyRow(h: HistoryEntry, labelOf: LabelOf): TransferRow {
  const state: TransferState =
    h.status === "success" ? "completed" : h.status === "cancelled" ? "cancelled" : "failed";
  return {
    id: `h${h.jobId}`,
    jobId: h.jobId,
    name: h.name,
    size: h.size,
    bytes: h.size,
    speed: 0,
    eta: null,
    pct: 100,
    state,
    accountId: h.accountId,
    dest: h.dest,
    source: labelOf(h.accountId),
    error: h.error,
    at: h.at,
    item: h.item,
  };
}

/** A finished/failed/cancelled upload (uploads carry their own final JobStatus). */
export function uploadHistoryRow(u: JobStatus, labelOf: LabelOf): TransferRow {
  const state: TransferState = u.success ? "completed" : u.cancelled ? "cancelled" : "failed";
  return {
    id: `u${u.jobId}`,
    jobId: u.jobId,
    name: u.name,
    size: u.totalBytes || u.bytes,
    bytes: u.bytes,
    speed: 0,
    eta: null,
    pct: 100,
    state,
    accountId: u.accountId,
    dest: u.dest,
    source: labelOf(u.accountId),
    error: u.error,
  };
}
