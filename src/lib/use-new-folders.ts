import { useEffect, useMemo } from "react";
import { useApp } from "../store/app";
import { useBrowse, browseKey, type SizeValue } from "../store/browse";
import { useHistory } from "../store/history";
import { useIndex } from "../store/index-store";
import { useNewFoldersBaseline, pickNewFolders } from "../store/new-folders";
import { useFolderStatus } from "../store/folder-status";
import { useVisited } from "../store/visited";
import type { Account } from "./tauri/commands";
import type { RcItem } from "./rc/browse";

export interface NewFolderGroup {
  account: Account;
  folders: RcItem[];
}

export interface NewFoldersResult {
  /** New root folders grouped by the drive they're on (only non-empty groups). */
  groups: NewFolderGroup[];
  /** Total count across all drives. */
  count: number;
  /** Sum of the KNOWN folder sizes (fills in as sizes resolve). */
  totalSize: number;
  /** True once every new folder has a resolved size. */
  allSized: boolean;
  /** A folder's size state: instant from the index, computed on demand, or unknown. */
  sizeOf: (accountId: string, path: string) => SizeValue | undefined;
}

/**
 * Aggregate the "newly added" root folders across every connected drive.
 *
 * Detection is cheap: one root listing per drive (reuses the browse store, no
 * full crawl) diffed against a persisted per-drive baseline, filtered to a date
 * window, minus anything already downloaded (see {@link pickNewFolders}). Folder
 * sizes come from the index when available, else the on-demand size queue.
 *
 * Shared by the New Folders screen, the dashboard stat card, and the sidebar
 * badge so the count is consistent everywhere.
 */
export function useNewFolders(): NewFoldersResult {
  const accounts = useApp((s) => s.accounts);
  const listings = useBrowse((s) => s.listings);
  const sizes = useBrowse((s) => s.sizes);
  const indexEntries = useIndex((s) => s.byAccount);
  const baseline = useNewFoldersBaseline((s) => s.baseline);
  const historyItems = useHistory((s) => s.items);
  const statusByAccount = useFolderStatus((s) => s.byAccount);
  const visitedByAccount = useVisited((s) => s.byAccount);

  // Ensure each drive's ROOT listing is loaded (one cheap call each; the browse
  // store caches + background-refreshes, so this is a no-op once warm).
  useEffect(() => {
    for (const a of accounts) void useBrowse.getState().ensure(a, "");
  }, [accounts]);

  // Seed a drive's baseline the first time its root listing arrives, so a
  // freshly-seen drive doesn't report every existing folder as new. Runs as an
  // effect (not in the memo) since it writes to the store.
  useEffect(() => {
    for (const a of accounts) {
      if (baseline[a.id] !== undefined) continue;
      const roots = listings[browseKey(a.id, "")];
      if (!roots) continue;
      useNewFoldersBaseline.getState().seed(a.id, roots.filter((i) => i.IsDir).map((d) => d.Path));
    }
  }, [accounts, listings, baseline]);

  // Per-account set of downloaded item paths, to drop folders already fetched.
  const downloadedByAccount = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const h of historyItems) {
      if (h.status !== "success" || !h.item?.path) continue;
      const set = map.get(h.accountId) ?? new Set<string>();
      set.add(h.item.path);
      map.set(h.accountId, set);
    }
    return map;
  }, [historyItems]);

  const groups = useMemo(() => {
    const isDownloadedUnder = (accountId: string, folderPath: string) => {
      const set = downloadedByAccount.get(accountId);
      if (!set) return false;
      if (set.has(folderPath)) return true;
      const prefix = `${folderPath}/`;
      for (const p of set) if (p.startsWith(prefix)) return true;
      return false;
    };
    const out: NewFolderGroup[] = [];
    for (const a of accounts) {
      const roots = listings[browseKey(a.id, "")];
      if (!roots || baseline[a.id] === undefined) continue; // not loaded / not yet seeded
      const statuses = statusByAccount[a.id] ?? {};
      // Once you HANDLE a folder (Downloaded / Copied / Downloading) it's no longer
      // "new" and drops off the screen — EXCEPT "On hold", which you deliberately
      // keep visible. Unstatused folders stay until handled.
      const news = pickNewFolders(roots, new Set(baseline[a.id]), (p) => isDownloadedUnder(a.id, p)).filter(
        (f) => {
          const st = statuses[f.Path];
          return !st || st === "on_hold";
        },
      );
      if (news.length) out.push({ account: a, folders: news });
    }
    return out;
  }, [accounts, listings, baseline, downloadedByAccount, statusByAccount]);

  // Kick off (lazy, concurrency-limited) size computation for each new folder
  // that isn't already sized by the index.
  const sizeOf = (accountId: string, path: string): SizeValue | undefined => {
    const agg = indexEntries[accountId]?.index?.agg[path];
    if (agg) return agg.size;
    return sizes[browseKey(accountId, path)];
  };
  // Trigger (lazy, concurrency-limited) size computation for any new folder not
  // already sized by the index. computeSize is a no-op when already known or
  // in-flight, so calling it broadly is safe.
  useEffect(() => {
    for (const g of groups) {
      for (const f of g.folders) {
        if (indexEntries[g.account.id]?.index?.agg[f.Path]) continue; // instant from index
        if (sizes[browseKey(g.account.id, f.Path)] !== undefined) continue;
        void useBrowse.getState().computeSize(g.account, f.Path);
      }
    }
  }, [groups, indexEntries, sizes]);

  // The badge counts only folders you HAVEN'T opened yet — opening one clears it
  // from the badge (it stays listed, dimmed, so you can still act on it).
  const count = groups.reduce((n, g) => {
    const seen = new Set(visitedByAccount[g.account.id] ?? []);
    return n + g.folders.filter((f) => !seen.has(f.Path)).length;
  }, 0);
  let totalSize = 0;
  let allSized = true;
  for (const g of groups) {
    for (const f of g.folders) {
      const s = sizeOf(g.account.id, f.Path);
      if (typeof s === "number") totalSize += s;
      else allSized = false;
    }
  }

  return { groups, count, totalSize, allSized, sizeOf };
}
