import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Upload, Loader2, AlertCircle, List as ListIcon, LayoutGrid, RefreshCw, Star, ChevronDown, ChevronLeft, ChevronRight, CornerLeftUp, Check, Play, Eye, FolderSearch, FolderOpen, Folder, FileSearch, FileUp, FolderUp, ArrowUp, ArrowDown, FolderTree, Trash2, Calculator, Copy, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp, type Section, type ReviewTarget } from "../store/app";
import { isVideo, isPreviewable, extOf } from "../lib/review";
import { useIndex } from "../store/index-store";
import { useBrowse, browseKey, browseSearchKey, browseRecentKey } from "../store/browse";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { useStarred } from "../store/starred";
import { useSelection, totalSelectedCount, totalSelectedSize, selectedDriveCount, type SelectedItem } from "../store/selection";
import { usePreview } from "../store/preview";
import { useHighlight } from "../store/highlight";
import { useVisited } from "../store/visited";
import { useHistory } from "../store/history";
import { useSearch } from "../store/search";
import { useSettings } from "../store/settings";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { ProviderIcon } from "./icons";
import { Button, Skeleton, EmptyState } from "./ui";
import { ContextMenu, type MenuItem } from "./ui/ContextMenu";
import { fileType } from "../lib/file-types";
import { itemAt } from "../lib/account-index";
import { IndexProgress } from "./IndexProgress";
import { formatBytes, formatDate, formatSpeed } from "../lib/format";
import { sortItems, DEFAULT_SORT, type SortField, type SortState } from "../lib/sort";
import { computeVirtualRange } from "../lib/virtual-rows";
import type { RcItem } from "../lib/rc/browse";
import { deleteItem } from "../lib/tauri/commands";
import type { Account, DownloadItem } from "../lib/tauri/commands";
import { FOLDER_KEY } from "../lib/ingest";
import { loadJson, loadRaw, saveJson } from "../lib/persisted";

const SORT_KEY = "browse_sort";
const EMPTY: RcItem[] = [];
const EMPTY_STARS: string[] = [];

/** Restore the persisted sort (field + direction + folders-first), falling back to the default. */
function loadSort(): SortState {
  const p = loadJson<Partial<SortState>>(SORT_KEY, {});
  const fields: SortField[] = ["name", "size", "modified", "type"];
  if (fields.includes(p.field as SortField) && (p.dir === "asc" || p.dir === "desc")) {
    return { field: p.field as SortField, dir: p.dir, foldersFirst: p.foldersFirst !== false };
  }
  return DEFAULT_SORT;
}

const SECTION_TITLE: Record<Section, string> = {
  all: "All Files",
  recent: "Recent",
  starred: "Starred",
  shared: "Shared with me",
};

/** A folder's size: instant from the index, computed on demand, or unknown. */
type FolderSizeState =
  | { kind: "known"; bytes: number }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "unknown" };

/** Size cell: instant from the index, a spinner while computing, or a
 *  "Calculate" action for folders whose size we don't auto-compute (shared).
 *  Shared between list and grid views so both stay in sync. */
function SizeCell({ item, folderSize, onCalcSize }: { item: RcItem; folderSize: FolderSizeState; onCalcSize: (p: string) => void }) {
  if (!item.IsDir) return <>{item.Size > 0 ? formatBytes(item.Size) : <span className="text-[var(--text-3)]">·</span>}</>;
  if (folderSize.kind === "known") return <>{folderSize.bytes > 0 ? formatBytes(folderSize.bytes) : <span className="text-[var(--text-3)]">·</span>}</>;
  if (folderSize.kind === "loading") return <Loader2 size={13} className="inline animate-spin text-[var(--text-3)]" />;
  return (
    <button
      onClick={() => onCalcSize(item.Path)}
      data-tip={folderSize.kind === "error" ? "Couldn’t size this folder. Click to retry." : "Calculate folder size on demand"}
      className="rounded-[6px] px-1.5 py-0.5 text-xs text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--accent)]"
    >
      {folderSize.kind === "error" ? "Retry" : "Calculate"}
    </button>
  );
}

/** Small corner badge on a folder's icon: a filled dot once something inside
 *  it has been downloaded, or a plain dot once it's just been opened. Shared
 *  between list and grid views so both stay in sync. */
function FolderBadge({ hasDownloads, visited }: { hasDownloads: boolean; visited: boolean }) {
  if (hasDownloads) {
    return (
      <span
        data-tip="Downloaded from this folder"
        className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--dl)] ring-2 ring-[var(--surface)]"
      >
        <Check size={8} strokeWidth={3} className="text-white" />
      </span>
    );
  }
  if (visited) {
    return (
      <span
        data-tip="Opened — nothing downloaded yet"
        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-[var(--text-3)] ring-2 ring-[var(--surface)]"
      />
    );
  }
  return null;
}

/** Stable-callback props every row/grid-item shares — identical shape so both
 * FileRow and FileGridItem can take the same object. */
interface RowActions {
  toggle: (p: string, shiftKey?: boolean) => void;
  openFolder: (p: string) => void;
  /** Single-click: lightweight preview overlay. */
  openPreview: (item: RcItem) => void;
  /** Right-click → Review: the full reviewer screen. */
  openReview: (item: RcItem) => void;
  download: (item: RcItem) => void;
  indexFolder: (p: string) => void;
  calcSize: (p: string) => void;
  toggleStar: (p: string) => void;
  deleteOne: (item: RcItem) => void;
  contextMenu: (x: number, y: number, item: RcItem) => void;
}

function folderSizeEqual(a: FolderSizeState, b: FolderSizeState): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "known" && b.kind === "known" ? a.bytes === b.bytes : true;
}

export function BrowsePane({ account, section, path }: { account: Account; section: Section; path: string }) {
  const setView = useApp((s) => s.setView);
  const canGoBack = useApp((s) => s.back.length > 0);
  const canGoForward = useApp((s) => s.forward.length > 0);
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);
  const goUp = useApp((s) => s.goUp);
  const openReview = useApp((s) => s.openReview);
  const entry = useIndex((s) => s.byAccount[account.id]);
  const enqueue = useTransfers((s) => s.enqueue);
  const toast = useToasts((s) => s.push);
  const q = useSearch((s) => s.q);
  const starred = useStarred((s) => s.byAccount[account.id]) ?? EMPTY_STARS;
  const toggleStar = useStarred((s) => s.toggle);

  // Folder badges: "visited" (opened at least once) persists across restarts;
  // "has downloads" is derived from history rather than stored separately, so
  // it can never drift from what was actually downloaded.
  const visitedList = useVisited((s) => s.byAccount[account.id]) ?? EMPTY_STARS;
  const visitedSet = useMemo(() => new Set(visitedList), [visitedList]);
  const historyItems = useHistory((s) => s.items);
  const downloadedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const h of historyItems) {
      if (h.accountId === account.id && h.status === "success" && h.item?.path) set.add(h.item.path);
    }
    return set;
  }, [historyItems, account.id]);
  const folderHasDownloads = (folderPath: string) => {
    if (downloadedPaths.has(folderPath)) return true;
    const prefix = `${folderPath}/`;
    for (const p of downloadedPaths) {
      if (p.startsWith(prefix)) return true;
    }
    return false;
  };
  const displayLabel = accountLabel(useAccountMeta((s) => s.byId[account.id]?.label), account);

  // Selection lives in a global store keyed by drive, so it PERSISTS across
  // folder and drive navigation — you can build up a selection across drives
  // and download it all at once.
  const selectionForAccount = useSelection((s) => s.byAccount[account.id]);
  const selected = useMemo(() => new Set(Object.keys(selectionForAccount ?? {})), [selectionForAccount]);
  const lastToggledPath = useRef<string | null>(null);
  const [grid, setGrid] = useState(false);
  const [sort, setSort] = useState<SortState>(loadSort);
  const [sortOpen, setSortOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // List-view virtualization: a folder full of raw footage can hold thousands
  // of files, and rendering every row as a real DOM node is exactly what was
  // freezing the app on large folders. Only the rows in (or near) the
  // viewport are ever mounted — see the `computeVirtualRange` call below.
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRaf = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowHeight, setRowHeight] = useState(50); // corrected once a real row is measured below

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      if (scrollRaf.current != null) return;
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = null;
        setScrollTop(el.scrollTop);
      });
    };
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (scrollRaf.current != null) cancelAnimationFrame(scrollRaf.current);
    };
  }, []);

  // Persist sort field + direction + folders-first so it sticks across sessions.
  useEffect(() => {
    saveJson(SORT_KEY, sort);
  }, [sort]);

  // Live, server-side Search + Recent — the "like the web" path. We NEVER crawl an
  // account into a local index automatically (Drive's "Shared with me" alone is
  // tens of TB). Search asks the provider directly (Drive files.list / Dropbox
  // search_v2); Recent uses Drive's modifiedTime sort. The store debounces the
  // outbound request and caches results per query, so typing fast doesn't fire
  // a request per keystroke and re-visiting a query is instant.
  const searching = q.trim().length > 0;
  const showingRecent = section === "recent" && !searching;
  const dropboxRecent = showingRecent && account.provider === "dropbox";
  const resultKey = searching ? browseSearchKey(account.id, q.trim()) : browseRecentKey(account.id);
  const serverItems = useBrowse((s) => (searching || showingRecent ? s.searchResults[resultKey] : undefined)) ?? EMPTY;
  const serverResultLoading = useBrowse((s) => s.searchLoading[resultKey]) ?? false;
  const serverResultError = useBrowse((s) => s.searchErrors[resultKey]);
  const serverState: "idle" | "loading" | "error" | "dropbox-recent" = !(searching || showingRecent)
    ? "idle"
    : dropboxRecent
      ? "dropbox-recent"
      : serverResultError
        ? "error"
        : serverResultLoading
          ? "loading"
          : "idle";

  useEffect(() => {
    if (dropboxRecent) return;
    if (searching) useBrowse.getState().search(account, q.trim());
    else if (showingRecent) useBrowse.getState().recent(account);
  }, [q, searching, showingRecent, dropboxRecent, account]);

  const index = entry?.index ?? null;
  const status = entry?.status ?? "idle";

  const browseSizes = useBrowse((s) => s.sizes);
  const aggOf = (p: string) => index?.agg[p];
  // A folder is "indexed" once the crawl captured its subtree (children or aggregate present).
  const folderIndexed = (p: string) => !!(index && (index.agg[p] || index.tree[p]));

  // Folder-size resolution. Owned accounts are crawled once at link time, so the
  // index aggregate gives an instant size. Shared ("Shared with me") folders are
  // NOT in the index and intentionally NOT auto-walked — they can be enormous or
  // not owned — so they read "unknown" until the user calculates one on demand.
  const folderSizeState = (p: string): FolderSizeState => {
    if (folderIndexed(p)) return { kind: "known", bytes: aggOf(p)?.size ?? 0 };
    const v = browseSizes[browseKey(account.id, p)];
    if (typeof v === "number") return { kind: "known", bytes: v };
    if (v === "loading") return { kind: "loading" };
    if (v === "error") return { kind: "error" };
    return { kind: "unknown" };
  };
  const calcSize = (p: string) => void useBrowse.getState().computeSize(account, p);

  const sizeOf = (i: RcItem): number => {
    if (!i.IsDir) return Math.max(0, i.Size);
    const st = folderSizeState(i.Path);
    return st.kind === "known" ? st.bytes : 0;
  };
  // A folder's size counts for sorting only once it's actually known — so
  // still-computing folders park stably at the bottom instead of jumping.
  const sizeKnownOf = (i: RcItem): boolean => (i.IsDir ? folderSizeState(i.Path).kind === "known" : true);
  // Folder date: index "latest file" if crawled, else the folder's own mod time
  // (instant from the live listing). Files use their own mod time.
  const dateOf = (i: RcItem) => (i.IsDir ? (aggOf(i.Path)?.latest || i.ModTime) : i.ModTime);
  // A folder's recursive file count, once the index has captured its subtree.
  const fileCountOf = (i: RcItem): number | undefined => (i.IsDir ? aggOf(i.Path)?.fileCount : undefined);
  const indexFolder = (folderPath: string) => void useIndex.getState().indexFolder(account, folderPath);

  // Delete (with confirm). Cloud deletes go to the provider Trash (recoverable).
  // pendingDelete holds one item (per-row trash) or many (selection-bar delete).
  const dropPath = useIndex((s) => s.dropPath);
  const [pendingDelete, setPendingDelete] = useState<RcItem[] | null>(null);
  // Right-click context menu (cursor-anchored, one item at a time).
  const [menu, setMenu] = useState<{ x: number; y: number; item: RcItem } | null>(null);
  const [deleting, setDeleting] = useState(false);
  async function confirmDelete() {
    const list = pendingDelete;
    if (!list || list.length === 0) return;
    setDeleting(true);
    let ok = 0;
    const fails: string[] = [];
    for (const it of list) {
      try {
        await deleteItem(account.id, it.Path, it.IsDir);
        dropPath(account.id, it.Path);
        ok++;
      } catch (e) {
        fails.push(`${it.Name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    useSelection.getState().clearAccount(account.id);
    if (ok) toast(`Deleted ${ok} item${ok > 1 ? "s" : ""} (moved to Trash)`, "success");
    if (fails.length) toast(`Delete failed: ${fails[0]}${fails.length > 1 ? ` (+${fails.length - 1} more)` : ""}`, "error");
    setDeleting(false);
    setPendingDelete(null);
  }
  const reviewTarget = (i: RcItem): ReviewTarget => ({ path: i.Path, name: i.Name, fileId: i.ID ?? "", size: sizeOf(i), ext: extOf(i.Name) });

  // Browse is LIVE: each folder is listed on demand (instant), independent of the
  // background index (which now only powers Recent + Search). Index entries are a
  // fallback shown until the live listing arrives.
  const folderView = section === "all" || section === "shared";
  const indexItems = folderView ? index?.tree[path] : undefined;
  const liveItems = useBrowse((s) => (folderView ? s.listings[browseKey(account.id, path)] : undefined));
  const liveLoading = useBrowse((s) => (folderView ? s.loading[browseKey(account.id, path)] : false)) ?? false;
  const liveError = useBrowse((s) => (folderView ? s.errors[browseKey(account.id, path)] : undefined));

  // List the current folder live whenever it changes — never wait for the crawl.
  useEffect(() => {
    if (folderView) {
      void useBrowse.getState().ensure(account, path);
      useVisited.getState().markVisited(account.id, path);
    }
  }, [folderView, path, account]);

  // Auto-index the drive in the background (when enabled) so every folder's
  // total SIZE + FILE COUNT is available by default. ensure() is idempotent
  // (serves from memory/disk, only crawls once) and runs on background threads,
  // so the main thread stays smooth — the crawl only shows a progress bar.
  const autoIndex = useSettings((s) => s.autoIndex);
  useEffect(() => {
    if (!autoIndex) return;
    // Don't auto-retry a crawl that ended in error — that would re-hammer the
    // provider on every visit to the account. The manual Re-index button still
    // lets the user retry. (ensure() itself skips loading/crawling/ready.)
    if (useIndex.getState().byAccount[account.id]?.status === "error") return;
    // ensureAuto() (not ensure()) so a crawl the user cancelled — which settles
    // status back to "idle" — is NOT silently restarted every time this pane
    // remounts (e.g. after a search or account switch).
    void useIndex.getState().ensureAuto(account);
  }, [account, autoIndex]);

  // Reset scroll position on navigation (selection now persists — it lives in
  // the global store, not here). Otherwise the virtualization window below would
  // briefly compute from the PREVIOUS folder's scroll offset.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [section, path, q]);

  // A pending highlight (e.g. jumped here from a search result): once this folder
  // has loaded the item, select it, scroll it into view, and flash it briefly so
  // you can see exactly which file the search meant.
  const [blinkPath, setBlinkPath] = useState<string | null>(null);

  const base: RcItem[] = useMemo(() => {
    // Search + Recent are LIVE server-side queries (no crawl). Starred reads from
    // an index ONLY if one was already built on demand (never auto-crawled).
    if (q.trim()) return serverItems;
    if (section === "recent") return serverItems;
    if (section === "starred") return index ? (starred.map((p) => itemAt(index, p)).filter(Boolean) as RcItem[]) : EMPTY;
    // all / shared: the LIVE listing is the source of truth (instant). If it's
    // empty or failed, fall back to an already-built index so folders still show.
    if (liveItems && liveItems.length) return liveItems;
    if (indexItems && indexItems.length) return indexItems;
    return liveItems ?? EMPTY;
  }, [index, q, section, starred, indexItems, liveItems, serverItems]);

  const items = useMemo(() => {
    return sortItems(base, sort, { sizeOf, dateOf, sizeKnown: sizeKnownOf });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, sort, index, browseSizes]);

  // NOTE: folder sizes are no longer auto-computed for every visible folder.
  // Owned folders get an instant size from the persisted index; shared / unindexed
  // folders show a "Calculate" action (renderFolderSize) so we never silently
  // recursive-walk a huge shared drive the user didn't ask about.

  // Correct the ROW_HEIGHT guess against a real rendered row so the virtual
  // spacer heights (below) match actual scroll height instead of drifting.
  useLayoutEffect(() => {
    if (grid) return;
    const row = bodyRef.current?.querySelector<HTMLElement>("tbody tr[data-row]");
    const h = row?.getBoundingClientRect().height;
    if (h && h > 0 && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
  }, [items, grid, rowHeight]);

  const virtualRange = grid ? { start: 0, end: items.length } : computeVirtualRange(scrollTop, viewportH, rowHeight, items.length);
  const visibleItems = items.slice(virtualRange.start, virtualRange.end);

  // Consume a pending highlight for THIS folder: select the item, scroll it into
  // view, and flash it. Runs once the target is present in `items`.
  const hlAccount = useHighlight((s) => s.accountId);
  const hlPath = useHighlight((s) => s.path);
  useEffect(() => {
    if (hlAccount !== account.id || !hlPath) return;
    const idx = items.findIndex((i) => i.Path === hlPath);
    if (idx === -1) return; // not loaded yet — wait for items to fill in
    const it = items[idx];
    useSelection.getState().add(account.id, [{ item: it, size: sizeOf(it) }]);
    // Center the row in the viewport (list view is virtualized by scrollTop).
    if (!grid && bodyRef.current && rowHeight > 0) {
      const target = Math.max(0, idx * rowHeight - bodyRef.current.clientHeight / 2 + rowHeight);
      bodyRef.current.scrollTop = target;
      setScrollTop(target);
    }
    setBlinkPath(hlPath);
    useHighlight.getState().clear();
    const t = setTimeout(() => setBlinkPath(null), 1800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlAccount, hlPath, items, rowHeight, grid, account.id]);

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.Path));
  // Totals span EVERY drive's selection (the bar aggregates cross-drive).
  const selectionAll = useSelection((s) => s.byAccount);
  const globalCount = totalSelectedCount(selectionAll);
  const globalSize = totalSelectedSize(selectionAll);
  const globalDrives = selectedDriveCount(selectionAll);

  const entryFor = (p: string): SelectedItem | null => {
    const it = items.find((i) => i.Path === p);
    return it ? { item: it, size: sizeOf(it) } : null;
  };

  // Shift+Click selects everything between the last-toggled row and this one
  // (inclusive) — the conventional Finder/Explorer/Gmail range-select. Only a
  // ref, not state: it doesn't need to trigger a render on its own.
  function toggle(p: string, shiftKey?: boolean) {
    if (shiftKey && lastToggledPath.current) {
      const paths = items.map((i) => i.Path);
      const a = paths.indexOf(lastToggledPath.current);
      const b = paths.indexOf(p);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = paths.slice(lo, hi + 1).map(entryFor).filter((e): e is SelectedItem => !!e);
        useSelection.getState().add(account.id, range);
        lastToggledPath.current = p;
        return;
      }
    }
    const e = entryFor(p);
    if (e) useSelection.getState().toggle(account.id, e);
    lastToggledPath.current = p;
  }

  // Upload local renders into the CURRENT folder. Editors connect their own
  // account and upload into a folder the owner shared with them (Editor
  // permission) — no credentials change hands. Dropbox links are read-only.
  const canUpload =
    folderView &&
    !searching &&
    !account.id.startsWith("dropboxlink_") &&
    (account.provider === "drive" || account.provider === "dropbox");
  // The in-folder strip is in-progress feedback: show active + failed/cancelled,
  // but not completed successes (those live on the Uploads screen now). A toast
  // already announces each success.
  const myUploads = useTransfers((s) => s.uploads).filter(
    (u) => u.accountId === account.id && !(u.finished && u.success),
  );
  async function pickUpload(directory: boolean) {
    setUploadOpen(false);
    const picked = await open(directory ? { directory: true, multiple: true } : { multiple: true });
    if (!picked) return;
    const paths = (Array.isArray(picked) ? picked : [picked]).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;
    void useTransfers.getState().startUploads(account.id, paths, path);
  }

  // Queue a set of items, prompting once for a destination folder if none is set.
  async function enqueueItems(its: RcItem[]) {
    if (its.length === 0) return;
    let dest = loadRaw(FOLDER_KEY, "");
    if (!dest) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      dest = picked;
    }
    const chosen: DownloadItem[] = its.map((i) => ({ path: i.Path, name: i.Name, isDir: i.IsDir, size: sizeOf(i), id: i.ID ?? "" }));
    enqueue(account.id, chosen, dest);
    toast(`Queued ${chosen.length} download${chosen.length === 1 ? "" : "s"}`, "success");
  }

  // Download EVERY selected item across ALL drives (the selection persists across
  // drives), then clear the whole selection.
  async function download() {
    const byAccount = useSelection.getState().byAccount;
    if (totalSelectedCount(byAccount) === 0) return;
    let dest = loadRaw(FOLDER_KEY, "");
    if (!dest) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      dest = picked;
    }
    let queued = 0;
    for (const [accId, map] of Object.entries(byAccount)) {
      const entries = Object.values(map);
      if (entries.length === 0) continue;
      const chosen: DownloadItem[] = entries.map((e) => ({ path: e.item.Path, name: e.item.Name, isDir: e.item.IsDir, size: e.size, id: e.item.ID ?? "" }));
      enqueue(accId, chosen, dest);
      queued += chosen.length;
    }
    useSelection.getState().clearAll();
    toast(`Queued ${queued} download${queued === 1 ? "" : "s"}`, "success");
  }

  // Stable row-facing callbacks: FileRow/FileGridItem are memoized, and every
  // closure above (enqueueItems, reviewTarget, indexFolder, etc.) is recreated
  // on every render, so passing them straight through would defeat the memo.
  // The ref always holds the LATEST closures; the wrappers below never change
  // identity, so rows only re-render when their own props actually change.
  const actionsRef = useRef<RowActions>(null!);
  actionsRef.current = {
    toggle,
    openFolder: (p) => setView({ kind: "browse", accountId: account.id, section: "all", path: p }),
    openPreview: (item) => usePreview.getState().open(account.id, reviewTarget(item)),
    openReview: (item) => openReview(account.id, reviewTarget(item)),
    download: (item) => void enqueueItems([item]),
    indexFolder,
    calcSize,
    toggleStar: (p) => toggleStar(account.id, p),
    deleteOne: (item) => setPendingDelete([item]),
    contextMenu: (x, y, item) => setMenu({ x, y, item }),
  };
  const rowActions = useRef<RowActions>({
    toggle: (p, shiftKey) => actionsRef.current.toggle(p, shiftKey),
    openFolder: (p) => actionsRef.current.openFolder(p),
    openPreview: (item) => actionsRef.current.openPreview(item),
    openReview: (item) => actionsRef.current.openReview(item),
    download: (item) => actionsRef.current.download(item),
    indexFolder: (p) => actionsRef.current.indexFolder(p),
    calcSize: (p) => actionsRef.current.calcSize(p),
    toggleStar: (p) => actionsRef.current.toggleStar(p),
    deleteOne: (item) => actionsRef.current.deleteOne(item),
    contextMenu: (x, y, item) => actionsRef.current.contextMenu(x, y, item),
  }).current;

  // Build the right-click menu for one item — reuses every existing row action.
  const menuItems = (item: RcItem): MenuItem[] => {
    const isStar = starred.includes(item.Path);
    const out: MenuItem[] = [];
    if (item.IsDir) {
      out.push({ label: "Open", icon: FolderOpen, onClick: () => setView({ kind: "browse", accountId: account.id, section: "all", path: item.Path }) });
      out.push({ label: "Calculate size", icon: Calculator, onClick: () => calcSize(item.Path) });
      out.push({ label: folderIndexed(item.Path) ? "Re-index folder" : "Index folder", icon: FolderSearch, disabled: showCrawl, onClick: () => indexFolder(item.Path) });
    } else if (isPreviewable(item.Name)) {
      out.push({ label: "Preview", icon: Eye, onClick: () => usePreview.getState().open(account.id, reviewTarget(item)) });
      out.push({ label: "Review", icon: Play, onClick: () => openReview(account.id, reviewTarget(item)) });
    }
    out.push({ label: "Download", icon: Download, onClick: () => void enqueueItems([item]) });
    out.push({ label: isStar ? "Unstar" : "Star", icon: Star, onClick: () => toggleStar(account.id, item.Path) });
    out.push({ label: "Copy name", icon: Copy, separator: true, onClick: () => void navigator.clipboard?.writeText(item.Name) });
    out.push({ label: "Delete", icon: Trash2, danger: true, separator: true, onClick: () => setPendingDelete([item]) });
    return out;
  };

  const segments = path ? path.split("/") : [];
  const showCrawl = status === "crawling" || status === "loading";
  // Folder views spin only while the LIVE listing is loading; Recent/Starred/Search
  // spin while their background index is still building.
  // Search + Recent spin on the live server query; folder views on the live list;
  // Starred never spins (it reads an already-built index or shows empty).
  const onServerQuery = q.trim().length > 0 || section === "recent";
  const spinner = onServerQuery
    ? serverState === "loading"
    : folderView
      ? liveLoading && items.length === 0
      : false;

  const SORTS: { key: SortField; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "modified", label: "Date modified" },
    { key: "size", label: "Size" },
    { key: "type", label: "Type" },
  ];
  const sortLabel = SORTS.find((s) => s.key === sort.field)?.label ?? "Name";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Crawl progress */}
      {status === "loading" && (
        <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm text-[var(--text-2)]">
          <Loader2 size={15} className="animate-spin text-[var(--accent)]" />
          <span>Loading cached index…</span>
          <Skeleton className="ml-1 h-2 w-24" />
        </div>
      )}
      {status === "crawling" && entry && <IndexProgress accountId={account.id} entry={entry} />}

      {/* Live-listing error (so a failed folder list isn't a silent empty screen). */}
      {folderView && liveError && (
        <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm text-[var(--error)]">
          <AlertCircle size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={liveError}>Couldn’t list this folder: {liveError}</span>
          <button className="shrink-0 underline hover:text-[var(--text)]" onClick={() => void useBrowse.getState().ensure(account, path)}>Retry</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-4">
        {/* Back / Forward / Up — history-based navigation (also Alt+←/→ and the
            mouse back/forward buttons, wired globally in AppShell). */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            aria-label="Back"
            data-tip="Back (Alt+←)"
            className="flex h-8 w-8 items-center justify-center rounded-[7px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronLeft size={17} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            aria-label="Forward"
            data-tip="Forward (Alt+→)"
            className="flex h-8 w-8 items-center justify-center rounded-[7px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight size={17} />
          </button>
          <button
            onClick={goUp}
            disabled={!path}
            aria-label="Up one folder"
            data-tip="Up one folder"
            className="flex h-8 w-8 items-center justify-center rounded-[7px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <CornerLeftUp size={16} />
          </button>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[15px]">
          <ProviderIcon provider={account.provider} size={18} />
          {q.trim() ? (
            <span className="ml-1 text-[var(--text-2)]">Search results for “{q}”</span>
          ) : folderView ? (
            <>
              <button className="ml-1 font-medium text-[var(--text)] hover:text-[var(--accent)]" onClick={() => setView({ kind: "browse", accountId: account.id, section, path: "" })}>
                {displayLabel}
              </button>
              {segments.map((seg, i) => (
                <span key={i} className="flex items-center gap-1.5 text-[var(--text-2)]">
                  <ChevronDown size={14} className="-rotate-90 text-[var(--text-3)]" />
                  <button className="hover:text-[var(--text)]" onClick={() => setView({ kind: "browse", accountId: account.id, section, path: segments.slice(0, i + 1).join("/") })}>
                    {seg}
                  </button>
                </span>
              ))}
            </>
          ) : (
            <span className="ml-1 font-medium text-[var(--text)]">{SECTION_TITLE[section]}</span>
          )}
        </div>

        {/* Upload local files/folders into the current folder (files land where
            you're looking). Hidden on read-only sources (Dropbox links). */}
        {canUpload && (
          <div className="relative">
            <button
              onClick={() => setUploadOpen((o) => !o)}
              data-tip="Upload into this folder"
              className="flex items-center gap-2 rounded-[8px] border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <Upload size={15} /> Upload <ChevronDown size={13} />
            </button>
            {uploadOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUploadOpen(false)} />
                <div className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--card)] py-1 shadow-[var(--shadow-lg)]">
                  <button
                    onClick={() => void pickUpload(false)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <FileUp size={14} /> Upload files…
                  </button>
                  <button
                    onClick={() => void pickUpload(true)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <FolderUp size={14} /> Upload folder…
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Sort: field picker + asc/desc toggle (+ folders-first). No overflow-hidden
            on the group — it would clip the dropdown; edge buttons are rounded instead. */}
        <div className="flex rounded-[8px] border border-[var(--border)]">
          <div className="relative">
            <button
              onClick={() => setSortOpen((o) => !o)}
              title="Sort by"
              className="flex items-center gap-2 rounded-l-[7px] px-3 py-1.5 text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              {sortLabel} <ChevronDown size={14} />
            </button>
            {sortOpen && (
              <>
                {/* click-outside backdrop */}
                <div className="fixed inset-0 z-10" onClick={() => setSortOpen(false)} />
              <div className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--card)] py-1 shadow-[var(--shadow-lg)]">
                {SORTS.map((o) => (
                  <button
                    key={o.key}
                    onClick={() => {
                      setSort((s) => ({ ...s, field: o.key }));
                      setSortOpen(false);
                    }}
                    title={`Sort by ${o.label.toLowerCase()}`}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    {o.label} {sort.field === o.key && <Check size={14} className="text-[var(--accent)]" />}
                  </button>
                ))}
                <div className="my-1 border-t border-[var(--border)]" />
                <button
                  onClick={() => {
                    setSort((s) => ({ ...s, foldersFirst: !s.foldersFirst }));
                    setSortOpen(false);
                  }}
                  title="Group folders above files regardless of sort field"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  <span className="flex items-center gap-2"><FolderTree size={14} /> Folders first</span>
                  {sort.foldersFirst && <Check size={14} className="text-[var(--accent)]" />}
                </button>
              </div>
              </>
            )}
          </div>
          <button
            onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
            title={sort.dir === "asc" ? "Ascending (click for descending)" : "Descending (click for ascending)"}
            aria-label={`Sort direction: ${sort.dir === "asc" ? "ascending" : "descending"}`}
            className="rounded-r-[7px] border-l border-[var(--border)] px-2 py-1.5 text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            {sort.dir === "asc" ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
          </button>
        </div>

        <div className="flex overflow-hidden rounded-[8px] border border-[var(--border)]">
          <button className={`px-2 py-1.5 ${!grid ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-3)]"}`} onClick={() => setGrid(false)} aria-label="List view"><ListIcon size={15} /></button>
          <button className={`px-2 py-1.5 ${grid ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-3)]"}`} onClick={() => setGrid(true)} aria-label="Grid view"><LayoutGrid size={15} /></button>
        </div>
        <button className="rounded-[8px] border border-[var(--border)] p-1.5 text-[var(--text-3)] hover:text-[var(--text)] disabled:opacity-50" onClick={() => useIndex.getState().recrawl(account)} disabled={showCrawl} aria-label="Re-index" title="Re-index (full refresh, picks up new/changed files)"><RefreshCw size={15} /></button>
      </div>

      {/* Section pills — All Files / Recent / Starred / Shared (moved here from the
          sidebar to match the redesign; each navigates the current account). */}
      {!q.trim() && (
        <div className="flex items-center gap-1.5 px-6 pb-3">
          {(Object.keys(SECTION_TITLE) as Section[]).map((k) => {
            const on = section === k;
            return (
              <button
                key={k}
                onClick={() => setView({ kind: "browse", accountId: account.id, section: k, path: "" })}
                className={`h-8 rounded-full border px-[15px] text-[12.5px] font-semibold ${
                  on
                    ? "border-[var(--acc)] bg-[var(--acc)] text-[var(--onacc)]"
                    : "border-[var(--line)] bg-[var(--card)] text-[var(--mut)] hover:border-[var(--line2)]"
                }`}
              >
                {SECTION_TITLE[k]}
              </button>
            );
          })}
        </div>
      )}

      {/* Body */}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto px-6 pb-2" data-testid="file-list">
        {status === "error" && (
          <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--error)]">
            <AlertCircle size={16} /> {entry?.error}
            <button className="ml-2 underline" onClick={() => useIndex.getState().recrawl(account)}>retry</button>
          </div>
        )}

        {spinner ? (
          <FileListSkeleton />
        ) : serverState === "error" ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-[var(--mut)]">
            <AlertCircle size={18} className="text-[var(--err)]" /> Couldn’t search this account. Check the connection and try again.
          </div>
        ) : serverState === "dropbox-recent" ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-[var(--mut)]">
            Recent isn’t available for Dropbox. Use <span className="font-semibold text-[var(--ink)]">Search</span> or browse <span className="font-semibold text-[var(--ink)]">All Files</span>.
          </div>
        ) : items.length === 0 ? (
          <BrowseEmptyState q={q} section={section} />
        ) : grid ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3 py-2">
            {items.map((item) => (
              <FileGridItem
                key={item.Path}
                item={item}
                isSelected={selected.has(item.Path)}
                blink={item.Path === blinkPath}
                folderSize={folderSizeState(item.Path)}
                folderCount={fileCountOf(item)}
                visited={item.IsDir && visitedSet.has(item.Path)}
                hasDownloads={item.IsDir && folderHasDownloads(item.Path)}
                actions={rowActions}
              />
            ))}
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse text-sm">
            <thead>
              <tr className="sticky top-0 z-10 bg-[var(--surface)] text-left text-xs text-[var(--text-3)]">
                <th className="w-9 py-2.5 pl-1"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => (allSelected ? useSelection.getState().clearAccount(account.id) : useSelection.getState().add(account.id, items.map((i) => ({ item: i, size: sizeOf(i) }))))} /></th>
                <th className="py-2.5 font-medium">Name</th>
                <th className="w-44 whitespace-nowrap py-2.5 font-medium">Modified</th>
                <th className="w-28 whitespace-nowrap py-2.5 text-right font-medium">Size</th>
                <th className="w-28 py-2.5 pl-6 font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {/* Spacer rows reserve the scroll height of the rows scrolled past
                  above/below the window, so the scrollbar and sticky header stay
                  accurate without every row actually being mounted. */}
              {virtualRange.start > 0 && (
                <tr aria-hidden style={{ height: virtualRange.start * rowHeight }}>
                  <td colSpan={5} />
                </tr>
              )}
              {visibleItems.map((item) => (
                <FileRow
                  key={item.Path}
                  item={item}
                  isSelected={selected.has(item.Path)}
                  blink={item.Path === blinkPath}
                  isStarred={starred.includes(item.Path)}
                  dateStr={formatDate(dateOf(item))}
                  folderSize={folderSizeState(item.Path)}
                  folderCount={fileCountOf(item)}
                  showCrawl={showCrawl}
                  folderIndexedFlag={folderIndexed(item.Path)}
                  visited={item.IsDir && visitedSet.has(item.Path)}
                  hasDownloads={item.IsDir && folderHasDownloads(item.Path)}
                  actions={rowActions}
                />
              ))}
              {virtualRange.end < items.length && (
                <tr aria-hidden style={{ height: (items.length - virtualRange.end) * rowHeight }}>
                  <td colSpan={5} />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Active uploads strip — live progress per upload; successful ones
          auto-clear (a toast announces them), failed ones stay dismissable. */}
      {myUploads.length > 0 && (
        <div className="border-t border-[var(--border)] bg-[var(--surface)] px-6 py-2">
          {myUploads.map((u) => {
            const pct = u.totalBytes > 0 ? Math.min(100, (u.bytes / u.totalBytes) * 100) : 0;
            const failed = u.finished && !u.success && !u.cancelled;
            return (
              <div key={u.jobId} className="flex items-center gap-3 py-1 text-sm">
                <Upload size={14} className={failed ? "shrink-0 text-[var(--err)]" : "shrink-0 text-[var(--dl)]"} />
                <span className="min-w-0 max-w-[40%] truncate text-[var(--text)]">{u.name}</span>
                {failed ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--err)]" title={u.error}>
                    {u.error || "Upload failed"}
                  </span>
                ) : u.cancelled ? (
                  <span className="flex-1 text-xs text-[var(--text-3)]">Cancelled</span>
                ) : (
                  <>
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--soft)]">
                      <div
                        className="h-full rounded-full bg-[var(--dl)] transition-[width] duration-500"
                        style={{ width: u.totalBytes > 0 ? `${pct}%` : "100%" }}
                      />
                    </div>
                    <span className="tnum shrink-0 text-xs text-[var(--text-2)]">
                      {u.totalBytes > 0 ? `${Math.floor(pct)}%` : formatBytes(u.bytes)}
                      {u.speed > 0 ? ` · ${formatSpeed(u.speed)}` : ""}
                    </span>
                  </>
                )}
                <button
                  onClick={() =>
                    u.finished || u.cancelled
                      ? useTransfers.getState().dismissUpload(u.jobId)
                      : void useTransfers.getState().cancel(u.jobId)
                  }
                  aria-label={u.finished || u.cancelled ? `Dismiss ${u.name}` : `Cancel upload of ${u.name}`}
                  data-tip={u.finished || u.cancelled ? "Dismiss" : "Cancel upload"}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--err)]"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Selection bar — spans EVERY drive's selection (persists across drives). */}
      {globalCount > 0 && (
        <div className="flex items-center justify-between gap-4 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-3">
          <span className="text-sm text-[var(--text-2)]">
            Selected: <span className="tnum text-[var(--text)]">{globalCount}</span> item{globalCount === 1 ? "" : "s"} · <span className="tnum text-[var(--text)]">{formatBytes(globalSize)}</span>
            {globalDrives > 1 && <span className="text-[var(--faint)]"> · across {globalDrives} drives</span>}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => useSelection.getState().clearAll()}>Clear</Button>
            {selected.size > 0 && (
              <Button variant="ghost" onClick={() => setPendingDelete(items.filter((i) => selected.has(i.Path)))}>
                <Trash2 size={16} /> Delete{globalDrives > 1 ? " here" : ""}
              </Button>
            )}
            <Button variant="download" onClick={download}><Download size={16} /> Download{globalDrives > 1 ? " all" : ""}</Button>
          </div>
        </div>
      )}

      {/* Delete confirmation (cloud deletes go to the provider Trash — recoverable). */}
      {pendingDelete && pendingDelete.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6" onClick={() => !deleting && setPendingDelete(null)}>
          <div className="w-full max-w-md rounded-[12px] border border-[var(--border-strong)] bg-[var(--card)] p-5 shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-[var(--text)]">
              <Trash2 size={18} className="text-[var(--error)]" />
              <h2 className="text-base font-semibold">
                Delete {pendingDelete.length === 1 ? pendingDelete[0].Name : `${pendingDelete.length} items`}?
              </h2>
            </div>
            <p className="mt-2 text-sm text-[var(--text-2)]">
              {pendingDelete.some((i) => i.IsDir) ? "This includes folders and everything inside them. " : ""}
              It's removed from <span className="text-[var(--text)]">{displayLabel}</span> and moved to the provider's Trash
              (Google Drive Trash / Dropbox history), recoverable there for a limited time.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>Cancel</Button>
              <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />} Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.item)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** A single hover-revealed row action (index / star / delete). Fixed 28px box so
 *  the cluster reserves consistent width and toggling opacity never shifts layout. */
function RowAction({
  onClick,
  disabled,
  tip,
  label,
  active,
  danger,
  green,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tip: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  green?: boolean;
  children: ReactNode;
}) {
  const hover = danger ? "hover:text-[var(--err)]" : green ? "hover:text-[var(--dl)]" : "hover:text-[var(--acc)]";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-tip={tip}
      aria-label={label}
      className={`flex h-7 w-7 items-center justify-center rounded-[6px] transition-opacity hover:bg-[var(--soft)] disabled:opacity-40 ${
        active ? "text-[var(--acc)] opacity-100" : `text-[var(--faint)] opacity-0 group-hover:opacity-100 ${hover}`
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One list-view row. Memoized: without this, resolving a folder's size (which
 * updates `browseSizes` and re-triggers the `items` sort) or ticking the
 * selection Set for one row re-rendered every visible row on every folder in
 * the account. Props are per-row primitives/derived values (not raw store
 * state) precisely so the comparator can tell "did THIS row change".
 */
const FileRow = memo(function FileRow({
  item,
  isSelected,
  blink,
  isStarred,
  dateStr,
  folderSize,
  folderCount,
  showCrawl,
  folderIndexedFlag,
  visited,
  hasDownloads,
  actions,
}: {
  item: RcItem;
  isSelected: boolean;
  blink: boolean;
  isStarred: boolean;
  dateStr: string;
  folderSize: FolderSizeState;
  folderCount: number | undefined;
  showCrawl: boolean;
  folderIndexedFlag: boolean;
  visited: boolean;
  hasDownloads: boolean;
  actions: RowActions;
}) {
  const ft = fileType(item.Name, item.IsDir);
  const ext = extOf(item.Name).replace(/^\./, "").slice(0, 4).toUpperCase();
  const sub = item.IsDir
    ? folderCount != null
      ? `${folderCount.toLocaleString()} file${folderCount === 1 ? "" : "s"}`
      : ""
    : `${ext || "FILE"}${item.Size > 0 ? ` · ${formatBytes(item.Size)}` : ""}`;
  const video = !item.IsDir && isVideo(item.Name);
  const previewableFlag = !item.IsDir && isPreviewable(item.Name);

  const tile = item.IsDir ? (
    <span className="relative flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-[var(--accw)]">
      <Folder size={18} className="text-[var(--acc)]" />
      <FolderBadge hasDownloads={hasDownloads} visited={visited} />
    </span>
  ) : (
    <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] font-mono text-[9.5px] font-semibold" style={{ background: "var(--accw)", color: ft.color }}>
      {ext || "FILE"}
    </span>
  );
  const body = (
    <>
      {tile}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-medium text-[var(--ink)]">{item.Name}</span>
          {isStarred && <Star size={11} fill="currentColor" className="shrink-0 text-[var(--warn)]" />}
          {video && <Play size={11} className="shrink-0 text-[var(--faint)] opacity-0 group-hover:opacity-100" />}
        </span>
        {sub && <span className="block truncate text-[11.5px] text-[var(--faint)]">{sub}</span>}
      </span>
    </>
  );
  const nameCell = item.IsDir ? (
    <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => actions.openFolder(item.Path)}>{body}</button>
  ) : previewableFlag ? (
    <button className="flex min-w-0 flex-1 items-center gap-3 text-left" data-tip="Preview (right-click → Review)" onClick={() => actions.openPreview(item)}>{body}</button>
  ) : (
    <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
  );

  return (
    <tr data-row onContextMenu={(e) => { e.preventDefault(); actions.contextMenu(e.clientX, e.clientY, item); }} className={`group border-b border-[var(--border)]/60 ${blink ? "animate-flash" : isSelected ? "bg-[var(--card)]" : "hover:bg-[var(--hover)]"}`}>
      <td className="w-9 py-2.5 pl-1">
        <input
          type="checkbox"
          aria-label={`Select ${item.Name}`}
          checked={isSelected}
          onChange={() => {}}
          onClick={(e) => actions.toggle(item.Path, e.shiftKey)}
        />
      </td>
      <td className="min-w-0 py-1.5 pr-3">
        <div className="flex min-w-0 items-center gap-3">
          {nameCell}
          {/* Fixed action cluster — reserved width (opacity, not display),
              so revealing it on hover never shifts the layout. */}
          <div className="flex shrink-0 items-center gap-0.5">
            {previewableFlag && (
              <RowAction onClick={() => actions.openPreview(item)} tip="Preview" label={`Preview ${item.Name}`}>
                <Eye size={14} />
              </RowAction>
            )}
            {video && (
              <RowAction onClick={() => actions.openReview(item)} tip="Review" label={`Review ${item.Name}`}>
                <Play size={14} />
              </RowAction>
            )}
            <RowAction onClick={() => actions.download(item)} tip="Download" label={`Download ${item.Name}`} green>
              <Download size={14} />
            </RowAction>
            {item.IsDir && (
              <RowAction
                onClick={() => actions.indexFolder(item.Path)}
                disabled={showCrawl}
                tip={folderIndexedFlag ? "Re-index this folder" : "Index this folder"}
                label={`Index ${item.Name}`}
              >
                <FolderSearch size={14} />
              </RowAction>
            )}
            <RowAction
              onClick={() => actions.toggleStar(item.Path)}
              tip={isStarred ? "Unstar" : "Star"}
              label="Star"
              active={isStarred}
            >
              <Star size={14} fill={isStarred ? "currentColor" : "none"} />
            </RowAction>
            <RowAction onClick={() => actions.deleteOne(item)} tip="Delete (moves to Trash)" label={`Delete ${item.Name}`} danger>
              <Trash2 size={14} />
            </RowAction>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap py-2 text-[var(--text-3)]">{dateStr}</td>
      <td className="tnum whitespace-nowrap py-2 text-right text-[var(--text-2)]">
        <SizeCell item={item} folderSize={folderSize} onCalcSize={actions.calcSize} />
      </td>
      <td className="py-2.5 pl-6 text-[var(--text-3)]">{ft.label}</td>
    </tr>
  );
},
(prev, next) =>
  prev.item === next.item &&
  prev.isSelected === next.isSelected &&
  prev.blink === next.blink &&
  prev.isStarred === next.isStarred &&
  prev.dateStr === next.dateStr &&
  prev.folderCount === next.folderCount &&
  prev.showCrawl === next.showCrawl &&
  prev.folderIndexedFlag === next.folderIndexedFlag &&
  prev.visited === next.visited &&
  prev.hasDownloads === next.hasDownloads &&
  folderSizeEqual(prev.folderSize, next.folderSize));

/** One grid-view card — same memoization rationale as FileRow. */
const FileGridItem = memo(function FileGridItem({
  item,
  isSelected,
  blink,
  folderSize,
  folderCount,
  visited,
  hasDownloads,
  actions,
}: {
  item: RcItem;
  isSelected: boolean;
  blink: boolean;
  folderSize: FolderSizeState;
  folderCount: number | undefined;
  visited: boolean;
  hasDownloads: boolean;
  actions: RowActions;
}) {
  const ft = fileType(item.Name, item.IsDir);
  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); actions.contextMenu(e.clientX, e.clientY, item); }}
      className={`relative flex flex-col items-center gap-3 rounded-[11px] border p-5 ${blink ? "animate-flash border-[var(--acc)]" : isSelected ? "border-[var(--accent)] bg-[var(--card)]" : "border-[var(--border)] hover:bg-[var(--hover)]"}`}
    >
      <input
        type="checkbox"
        aria-label={`Select ${item.Name}`}
        checked={isSelected}
        onChange={() => {}}
        onClick={(e) => actions.toggle(item.Path, e.shiftKey)}
        className="absolute left-3 top-3"
      />
      <button
        className="flex flex-col items-center gap-2 text-center"
        onClick={() => (item.IsDir ? actions.openFolder(item.Path) : isPreviewable(item.Name) && actions.openPreview(item))}
      >
        <span className="relative flex items-center justify-center">
          <ft.Icon size={30} style={{ color: ft.color }} />
          {item.IsDir && <FolderBadge hasDownloads={hasDownloads} visited={visited} />}
        </span>
        <span className="line-clamp-2 text-sm text-[var(--text)]">{item.Name}</span>
      </button>
      <span className="tnum text-xs text-[var(--text-3)]">
        <SizeCell item={item} folderSize={folderSize} onCalcSize={actions.calcSize} />
        {item.IsDir && folderCount != null && (
          <span className="text-[var(--text-3)]"> · {folderCount.toLocaleString()} file{folderCount === 1 ? "" : "s"}</span>
        )}
      </span>
    </div>
  );
},
(prev, next) =>
  prev.item === next.item &&
  prev.isSelected === next.isSelected &&
  prev.blink === next.blink &&
  prev.folderCount === next.folderCount &&
  prev.visited === next.visited &&
  prev.hasDownloads === next.hasDownloads &&
  folderSizeEqual(prev.folderSize, next.folderSize));

/** Shimmer placeholder rows shown while a folder/index loads, shaped like the
 *  file table so the transition to real rows reads as instant. */
function FileListSkeleton() {
  return (
    <div className="py-2" data-testid="file-list-skeleton">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-[var(--border)]/40 py-3">
          <Skeleton className="h-[18px] w-[18px] shrink-0 rounded" />
          <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 13) % 45)}%` }} />
          <div className="flex-1" />
          <Skeleton className="h-3 w-28 shrink-0" />
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Friendly empty-state copy for the three empty cases (search / starred / folder). */
function BrowseEmptyState({ q, section }: { q: string; section: Section }) {
  const Icon = q ? FileSearch : section === "starred" ? Star : FolderOpen;
  const title = q ? "No matches" : section === "starred" ? "No starred items yet" : "This folder is empty";
  const body = q
    ? `Nothing here matches “${q}”. Try a different search.`
    : section === "starred"
      ? "Star files and folders to pin them here for quick access."
      : "Nothing to show in this folder.";
  return <EmptyState icon={<Icon size={20} />} title={title} body={body} />;
}
