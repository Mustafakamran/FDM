import { create } from "zustand";
import type { JobStatus, DownloadItem } from "../lib/tauri/commands";
import { categoryFor, type Category } from "../lib/categories";
import { loadJson, saveJson } from "../lib/persisted";

const KEY = "download_history_v1";
const CAP = 500;

/**
 * Per-job stats accumulated while a download is in flight (from the 1s poll
 * speed samples), folded into the history entry on finish so the detail panel
 * can show duration + speed envelope. All fields optional so entries recorded
 * before this was added (or jobs with no observed stats) still validate.
 */
export interface JobStats {
  /** First observation timestamp (ms). */
  startedAt?: number;
  /** Highest observed speed (bytes/s). */
  peakSpeed?: number;
  /** Lowest observed NON-ZERO speed (bytes/s). */
  minSpeed?: number;
  /** Last poll timestamp (ms) — used to derive duration if no finish time. */
  lastAt?: number;
}

export interface HistoryEntry {
  jobId: number;
  name: string;
  accountId: string;
  dest: string;
  size: number;
  status: "success" | "failed" | "cancelled";
  at: number;
  /** Failure reason (for failed entries). */
  error?: string;
  /** Original download item, so a failed entry can be resumed (re-enqueued from
   * its on-disk partial). Absent on entries recorded before this was added. */
  item?: DownloadItem;
  // --- Rich detail (all optional; absent on legacy entries) ---
  /** When the transfer was first observed running (ms epoch). */
  startedAt?: number;
  /** When it finished (ms epoch). */
  finishedAt?: number;
  /** Wall-clock duration in ms (finishedAt − startedAt), when both are known. */
  durationMs?: number;
  /** Average speed over the transfer (size / duration, bytes/s). */
  avgSpeed?: number;
  /** Peak observed speed (bytes/s). */
  maxSpeed?: number;
  /** Lowest observed non-zero speed (bytes/s). */
  minSpeed?: number;
  /** File category, from {@link categoryFor}. */
  category?: Category;
  /** Source URL for web (http) downloads — the item id is the URL. */
  sourceUrl?: string;
}

/**
 * Fold a job + its accumulated in-flight stats into the persisted finish-time
 * detail fields. Pure (timestamps passed in) so it can be unit-tested.
 *
 * - duration prefers (finishedAt − startedAt); falls back to the last sample.
 * - avgSpeed = size / durationSeconds (0 when duration is unknown/zero).
 */
export function computeFinishStats(
  size: number,
  stats: JobStats | undefined,
  finishedAt: number,
): Pick<HistoryEntry, "startedAt" | "finishedAt" | "durationMs" | "avgSpeed" | "maxSpeed" | "minSpeed"> {
  const startedAt = stats?.startedAt;
  const endAt = finishedAt || stats?.lastAt;
  const durationMs =
    startedAt != null && endAt != null && endAt > startedAt ? endAt - startedAt : undefined;
  const avgSpeed =
    durationMs && durationMs > 0 && size > 0 ? Math.round(size / (durationMs / 1000)) : undefined;
  return {
    startedAt,
    // Only stamp a finish time when we actually have one (the live path always
    // passes Date.now(); a 0/missing arg leaves it unset).
    finishedAt: startedAt != null && finishedAt ? finishedAt : undefined,
    durationMs,
    avgSpeed,
    maxSpeed: stats?.peakSpeed,
    minSpeed: stats?.minSpeed,
  };
}

const load = () => loadJson<HistoryEntry[]>(KEY, []);
const persist = (items: HistoryEntry[]) => saveJson(KEY, items.slice(0, CAP));

interface HistoryState {
  items: HistoryEntry[];
  recorded: Set<number>;
  record: (job: JobStatus, item?: DownloadItem, stats?: JobStats) => void;
  /** Drop one entry (e.g. after the user resumes a failed download). */
  removeEntry: (jobId: number) => void;
  clear: () => void;
}

export const useHistory = create<HistoryState>((set, get) => {
  const items = load();
  return {
    items,
    recorded: new Set(items.map((i) => i.jobId)),

    record: (job, item, stats) => {
      if (!job.finished && !job.cancelled) return;
      if (get().recorded.has(job.jobId)) return;
      const status = job.cancelled ? "cancelled" : job.success ? "success" : "failed";
      const now = Date.now();
      const size = job.totalBytes || job.bytes;
      // http downloads carry the source URL as the item id.
      const sourceUrl = item?.id && /^https?:\/\//i.test(item.id) ? item.id : undefined;
      const entry: HistoryEntry = {
        jobId: job.jobId,
        name: job.name,
        accountId: job.accountId,
        dest: job.dest,
        size,
        status,
        at: now,
        error: status === "failed" ? job.error : undefined,
        // Keep the item on failures so the user can resume from history.
        item: status === "failed" ? item : undefined,
        category: categoryFor(job.name),
        sourceUrl,
        ...computeFinishStats(size, stats, now),
      };
      const recorded = new Set(get().recorded);
      recorded.add(job.jobId);
      const next = [entry, ...get().items].slice(0, CAP);
      persist(next);
      set({ items: next, recorded });
    },

    removeEntry: (jobId) => {
      const recorded = new Set(get().recorded);
      recorded.delete(jobId);
      const next = get().items.filter((i) => i.jobId !== jobId);
      persist(next);
      set({ items: next, recorded });
    },

    clear: () => {
      persist([]);
      set({ items: [], recorded: new Set() });
    },
  };
});
