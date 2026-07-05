import { useMemo } from "react";
import { useTransfers } from "../store/transfers";
import { useHistory } from "../store/history";

export type DlState = "downloading" | "queued" | "paused" | "completed" | "failed" | "cancelled";

export interface DlStatus {
  state: DlState;
  /** Live percent for an active download. */
  pct?: number;
}

/**
 * Map of source path → live transfer status for one account, so the file browser
 * can badge the actual source file/folder (not just the Transfers screen) and
 * update it as the transfer progresses / completes / fails.
 *
 * Priority (later wins): history (completed/failed/cancelled) < queued/paused <
 * an active download (with live percent). Keyed by `DownloadItem.path`, which is
 * exactly the browse row's `Path`.
 */
export function useDownloadStatusMap(accountId: string): Map<string, DlStatus> {
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const inflight = useTransfers((s) => s.inflight);
  const history = useHistory((s) => s.items);
  return useMemo(() => {
    const map = new Map<string, DlStatus>();
    for (const h of history) {
      if (h.accountId !== accountId || !h.item?.path) continue;
      map.set(h.item.path, {
        state: h.status === "success" ? "completed" : h.status === "failed" ? "failed" : "cancelled",
      });
    }
    for (const q of queue) {
      if (q.accountId !== accountId || !q.item.path) continue;
      map.set(q.item.path, { state: q.paused ? "paused" : "queued" });
    }
    const jobById = new Map(jobs.map((j) => [j.jobId, j]));
    for (const inf of inflight) {
      if (inf.accountId !== accountId || !inf.item.path) continue;
      const j = jobById.get(inf.jobId);
      if (!j || j.finished || j.cancelled) continue;
      const pct = j.totalBytes > 0 ? Math.min(100, Math.round((j.bytes / j.totalBytes) * 100)) : 0;
      map.set(inf.item.path, { state: "downloading", pct });
    }
    return map;
  }, [jobs, queue, inflight, history, accountId]);
}
