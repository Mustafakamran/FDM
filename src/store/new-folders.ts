import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persisted";
import type { RcItem } from "../lib/rc/browse";

const KEY = "new_folders_baseline_v1";

/** How recent a root folder's modified-time must be to count as "newly added". */
export const NEW_FOLDER_WINDOW_DAYS = 30;

const load = () => loadJson<Record<string, string[]>>(KEY, {});

interface BaselineState {
  /** Per-account snapshot of top-level folder paths known as of first sighting.
   *  A root folder counts as "new" only if it's NOT in this set (see
   *  {@link pickNewFolders}). */
  baseline: Record<string, string[]>;
  /** Seed an account's baseline the first time we see its root listing, so a
   *  freshly-connected drive doesn't dump every existing folder as "new". No-op
   *  once seeded — later-appearing folders are then genuinely new. */
  seed: (accountId: string, rootFolderPaths: string[]) => void;
  /** Forget an account's baseline (on removal). */
  reset: (accountId: string) => void;
}

export const useNewFoldersBaseline = create<BaselineState>((set, get) => ({
  baseline: load(),

  seed: (accountId, rootFolderPaths) => {
    if (get().baseline[accountId] !== undefined) return; // already seeded
    const baseline = { ...get().baseline, [accountId]: rootFolderPaths };
    saveJson(KEY, baseline);
    set({ baseline });
  },

  reset: (accountId) => {
    const baseline = { ...get().baseline };
    delete baseline[accountId];
    saveJson(KEY, baseline);
    set({ baseline });
  },
}));

/** Whether an ISO modified-time is within the last `windowDays` of `nowMs`. */
function withinWindow(modTime: string, nowMs: number, windowDays: number): boolean {
  if (!modTime) return false; // no date → don't guess it's new
  const t = Date.parse(modTime);
  return Number.isFinite(t) && t >= nowMs - windowDays * 86_400_000;
}

/**
 * The "newly added" root folders from a drive's top-level listing: a folder that
 * is (a) NOT in the seeded baseline — i.e. appeared since we first saw this drive
 * — AND (b) modified within the date window — AND (c) not already downloaded.
 * Pure, so it's unit-tested without the store.
 */
export function pickNewFolders(
  rootItems: RcItem[],
  baseline: Set<string>,
  isDownloaded: (path: string) => boolean,
  nowMs: number,
  windowDays: number = NEW_FOLDER_WINDOW_DAYS,
): RcItem[] {
  return rootItems.filter(
    (i) => i.IsDir && !baseline.has(i.Path) && !isDownloaded(i.Path) && withinWindow(i.ModTime, nowMs, windowDays),
  );
}
