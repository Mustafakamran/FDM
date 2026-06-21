import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

// The pending Update handle is a class instance from the plugin — kept outside
// zustand state (not serializable / not for rendering).
let pending: Update | null = null;

interface UpdaterState {
  phase: UpdatePhase;
  version: string;
  notes: string;
  downloaded: number;
  total: number;
  error: string;
  /** User closed the "update available" banner (until next check). */
  dismissed: boolean;
  /** True when a manual check is running, so Settings can show feedback. */
  manual: boolean;

  /** Look for an update. `manual` surfaces "up to date"/errors to the user. */
  check: (manual?: boolean) => Promise<void>;
  /** Download + install the pending update, then relaunch. */
  install: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  phase: "idle",
  version: "",
  notes: "",
  downloaded: 0,
  total: 0,
  error: "",
  dismissed: false,
  manual: false,

  check: async (manual = false) => {
    if (get().phase === "downloading") return; // never interrupt an install
    set({ phase: "checking", error: "", manual, dismissed: false });
    try {
      const update = await check();
      if (update) {
        pending = update;
        set({ phase: "available", version: update.version, notes: update.body ?? "" });
      } else {
        set({ phase: "uptodate" });
      }
    } catch (e) {
      // No updater runtime (e.g. dev/test) or network error. Stay quiet on auto.
      set({ phase: manual ? "error" : "idle", error: String(e) });
    } finally {
      set({ manual: false });
    }
  },

  install: async () => {
    if (!pending) return;
    set({ phase: "downloading", downloaded: 0, total: 0, error: "" });
    try {
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          set({ total: event.data.contentLength ?? 0 });
        } else if (event.event === "Progress") {
          set((s) => ({ downloaded: s.downloaded + event.data.chunkLength }));
        } else if (event.event === "Finished") {
          set({ phase: "ready" });
        }
      });
      set({ phase: "ready" });
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
