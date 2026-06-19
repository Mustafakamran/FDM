import { create } from "zustand";
import {
  startDownload,
  listJobs,
  cancelJob,
  clearFinishedJobs,
  type DownloadItem,
  type JobStatus,
} from "../lib/tauri/commands";
import { loadPerf, toRcConfig } from "../lib/perf";

let pollTimer: ReturnType<typeof setInterval> | null = null;

interface TransfersState {
  jobs: JobStatus[];
  dockOpen: boolean;

  setDockOpen: (open: boolean) => void;
  start: (accountId: string, items: DownloadItem[], dest: string) => Promise<void>;
  refresh: () => Promise<void>;
  cancel: (jobId: number) => Promise<void>;
  clearFinished: () => Promise<void>;
  ensurePolling: () => void;
  stopPolling: () => void;
}

export const useTransfers = create<TransfersState>((set, get) => ({
  jobs: [],
  dockOpen: true,

  setDockOpen: (dockOpen) => set({ dockOpen }),

  start: async (accountId, items, dest) => {
    const created = await startDownload(accountId, items, dest, toRcConfig(loadPerf()));
    set((s) => {
      const known = new Set(s.jobs.map((j) => j.jobId));
      return { jobs: [...s.jobs, ...created.filter((j) => !known.has(j.jobId))], dockOpen: true };
    });
    get().ensurePolling();
  },

  refresh: async () => {
    const jobs = await listJobs();
    set({ jobs });
    // Stop polling once nothing is active.
    const active = jobs.some((j) => !j.finished && !j.cancelled);
    if (!active) get().stopPolling();
  },

  cancel: async (jobId) => {
    await cancelJob(jobId);
    await get().refresh();
  },

  clearFinished: async () => {
    await clearFinishedJobs();
    await get().refresh();
  },

  ensurePolling: () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      get()
        .refresh()
        .catch(() => {
          /* transient; next tick retries */
        });
    }, 1000);
  },

  stopPolling: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));
