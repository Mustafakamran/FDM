import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persisted";
import type { RcItem } from "../lib/rc/browse";

const KEY = "new_folders_baseline_v1";

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

/**
 * The "newly added" root folders from a drive's top-level listing: a folder that
 * is (a) NOT in the seeded baseline — i.e. appeared since we first saw this drive
 * — AND (b) not already downloaded.
 *
 * Detection is deliberately NOT gated on the folder's modified-time: a folder a
 * client newly *shares* keeps its original content date (a 3-month-old shoot
 * shared today still reads as 3 months old), so a modified-time window wrongly
 * hides exactly the folders this screen exists to surface. "Appeared since we
 * started watching this drive" (the baseline diff) is the correct signal.
 *
 * Pure, so it's unit-tested without the store.
 */
export function pickNewFolders(
  rootItems: RcItem[],
  baseline: Set<string>,
  isDownloaded: (path: string) => boolean,
): RcItem[] {
  return rootItems.filter((i) => i.IsDir && !baseline.has(i.Path) && !isDownloaded(i.Path));
}
