import { create } from "zustand";
import type { JobStatus } from "../lib/tauri/commands";

const KEY = "download_history_v1";
const CAP = 500;

export interface HistoryEntry {
  jobId: number;
  name: string;
  accountId: string;
  dest: string;
  size: number;
  status: "success" | "failed" | "cancelled";
  at: number;
}

function load(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}
function persist(items: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, CAP)));
  } catch {
    /* ignore quota */
  }
}

interface HistoryState {
  items: HistoryEntry[];
  recorded: Set<number>;
  record: (job: JobStatus) => void;
  clear: () => void;
}

export const useHistory = create<HistoryState>((set, get) => {
  const items = load();
  return {
    items,
    recorded: new Set(items.map((i) => i.jobId)),

    record: (job) => {
      if (!job.finished && !job.cancelled) return;
      if (get().recorded.has(job.jobId)) return;
      const status = job.cancelled ? "cancelled" : job.success ? "success" : "failed";
      const entry: HistoryEntry = {
        jobId: job.jobId,
        name: job.name,
        accountId: job.accountId,
        dest: job.dest,
        size: job.totalBytes || job.bytes,
        status,
        at: Date.now(),
      };
      const recorded = new Set(get().recorded);
      recorded.add(job.jobId);
      const next = [entry, ...get().items].slice(0, CAP);
      persist(next);
      set({ items: next, recorded });
    },

    clear: () => {
      persist([]);
      set({ items: [], recorded: new Set() });
    },
  };
});
