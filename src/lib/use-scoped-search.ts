import { useEffect, useMemo } from "react";
import { useApp } from "../store/app";
import { useSearch, type SearchScope } from "../store/search";
import { useBrowse, browseKey, browseSearchKey } from "../store/browse";
import { useGlobalSearch, type GlobalHit } from "../store/global-search";
import { useIndex } from "../store/index-store";
import type { Account } from "./tauri/commands";
import type { RcItem } from "./rc/browse";

export interface ScopedSearch {
  /** The scope actually in effect (override if valid in this context, else default). */
  scope: SearchScope;
  /** Scopes that make sense right now, for the chip row (always includes "all"). */
  available: SearchScope[];
  /** The drive being searched for folder/drive scope (undefined for "all"). */
  account?: Account;
  /** The folder path being searched for folder scope. */
  folderPath?: string;
  hits: GlobalHit[];
  loading: boolean;
  error?: string;
  /** Folder scope only: false when the drive isn't indexed, so results are
   *  limited to the folder's direct contents (deeper search needs an index). */
  folderRecursive: boolean;
}

const EMPTY: GlobalHit[] = [];

function tag(items: RcItem[], account: Account): GlobalHit[] {
  return items.map((it) => ({ ...it, AccountId: account.id, Provider: account.provider }));
}

function nameMatches(name: string, q: string): boolean {
  return name.toLowerCase().includes(q);
}

/**
 * Resolve the current query into results for the effective scope:
 *   • "all"    → live search across every connected drive (search_all_accounts).
 *   • "drive"  → live server-side search of the current drive (account_search),
 *                recursive across the whole drive.
 *   • "folder" → the folder you're in: its whole subtree when that drive has been
 *                indexed, otherwise just its direct contents (client-side filter,
 *                no crawl) with `folderRecursive:false` so the UI can offer to index.
 *
 * Scope is context-aware: browsing a non-root folder defaults to "folder", a
 * drive root to "drive", anywhere else to "all"; the user can override per search.
 */
export function useScopedSearch(): ScopedSearch {
  const q = useSearch((s) => s.q).trim();
  const scopeOverride = useSearch((s) => s.scopeOverride);
  const view = useApp((s) => s.view);
  const accounts = useApp((s) => s.accounts);

  const account = view.kind === "browse" ? accounts.find((a) => a.id === view.accountId) : undefined;
  const folderPath = view.kind === "browse" && view.path ? view.path : undefined;
  const inFolder = !!account && !!folderPath;
  const inDrive = !!account;

  const available = useMemo<SearchScope[]>(() => {
    const list: SearchScope[] = [];
    if (inFolder) list.push("folder");
    if (inDrive) list.push("drive");
    list.push("all");
    return list;
  }, [inFolder, inDrive]);

  const scope: SearchScope =
    scopeOverride && available.includes(scopeOverride) ? scopeOverride : available[0];

  // Fire the server-side searches for the active scope (both stores debounce +
  // cache internally, so re-runs are cheap).
  const globalRun = useGlobalSearch((s) => s.run);
  useEffect(() => {
    if (!q) return;
    if (scope === "all") globalRun(q);
    else if (scope === "drive" && account) useBrowse.getState().search(account, q);
    // "folder" needs no request — it filters cached data below.
  }, [q, scope, account, globalRun]);

  // --- Read results for the active scope ---
  const globalResults = useGlobalSearch((s) => s.results);
  const globalLoading = useGlobalSearch((s) => s.loading);
  const globalError = useGlobalSearch((s) => s.error);

  const driveKey = account ? browseSearchKey(account.id, q) : "";
  const driveItems = useBrowse((s) => (scope === "drive" ? s.searchResults[driveKey] : undefined));
  const driveLoading = useBrowse((s) => (scope === "drive" ? s.searchLoading[driveKey] : false)) ?? false;
  const driveError = useBrowse((s) => (scope === "drive" ? s.searchErrors[driveKey] : undefined));

  const indexEntry = useIndex((s) => (account ? s.byAccount[account.id] : undefined));
  const folderListing = useBrowse((s) => (account && folderPath ? s.listings[browseKey(account.id, folderPath)] : undefined));

  // Folder scope: subtree from the index if present, else the folder's direct
  // contents (already loaded by the browse view).
  const folder = useMemo<{ hits: GlobalHit[]; recursive: boolean }>(() => {
    if (scope !== "folder" || !account || !folderPath || !q) return { hits: EMPTY, recursive: false };
    const idx = indexEntry?.index;
    if (idx) {
      const prefix = `${folderPath}/`;
      const out: RcItem[] = [];
      for (const children of Object.values(idx.tree)) {
        for (const e of children) {
          if (e.Path.startsWith(prefix) && nameMatches(e.Name, q)) out.push(e);
        }
      }
      return { hits: tag(out, account), recursive: true };
    }
    const direct = (folderListing ?? []).filter((it) => nameMatches(it.Name, q));
    return { hits: tag(direct, account), recursive: false };
  }, [scope, account, folderPath, q, indexEntry, folderListing]);

  if (!q) return { scope, available, account, folderPath, hits: EMPTY, loading: false, folderRecursive: false };

  if (scope === "all") {
    return { scope, available, hits: globalResults, loading: globalLoading, error: globalError, folderRecursive: false };
  }
  if (scope === "drive") {
    return {
      scope,
      available,
      account,
      hits: account ? tag(driveItems ?? EMPTY, account) : EMPTY,
      loading: driveLoading,
      error: driveError,
      folderRecursive: false,
    };
  }
  // folder
  return { scope, available, account, folderPath, hits: folder.hits, loading: false, folderRecursive: folder.recursive };
}
