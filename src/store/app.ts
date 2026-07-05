import { create } from "zustand";
import { listAccounts, removeAccount, type Account } from "../lib/tauri/commands";
import { useIndex } from "./index-store";
import { useGlobalSearch } from "./global-search";
import { useToasts } from "./toast";
import { prettyLabel } from "./account-meta";
import type { Category } from "../lib/categories";

/** Category filter for the GENERAL / WEB DOWNLOADS view ("All" passes all). */
export type WebCategoryFilter = "All" | Category;

export type Section = "all" | "recent" | "starred" | "shared";

export type View =
  | { kind: "browse"; accountId: string; section: Section; path: string }
  // The Downloads area. `web` selects the GENERAL / WEB DOWNLOADS sub-view
  // (secondary-lane http/ytdlp jobs) instead of the primary Drive/Dropbox
  // transfers list; `detail` pins one web download open in the detail panel
  // (keyed by its job id as `j<jobId>`, or a queue id). It is exposed as a
  // distinct top-level destination ("web-downloads") via showWebDownloads(),
  // but shares the `downloads` view kind so the shared app router (AppShell)
  // mounts <DownloadsView/> for it without needing a per-kind branch edit —
  // DownloadsView itself switches to <GeneralDownloads/> when `web` is set.
  | { kind: "downloads"; filter: DownloadFilter; web?: boolean; detail?: string; category?: WebCategoryFilter }
  // The Uploads area — a mirror of Downloads for local → cloud transfers.
  | { kind: "uploads"; filter: DownloadFilter }
  // Unified Transfers screen: every download (Drive/Dropbox/web/torrent) AND
  // uploads in one torrent-style table, filtered by direction/state. This is the
  // single destination the sidebar navigates to; the older `downloads`/`uploads`
  // kinds above are retained only for type-compat and are no longer routed.
  | { kind: "transfers"; filter: TransferFilter }
  // "New folders" — root folders recently added to any drive (see NewFoldersView).
  | { kind: "new-folders" }
  | { kind: "review"; accountId: string; target: ReviewTarget }
  // Dashboard / landing: at-a-glance stats (accounts, storage, downloads, files).
  | { kind: "home" }
  | { kind: "accounts" };

export type DownloadFilter = "all" | "active" | "completed" | "failed";

/** Filter for the unified Transfers screen (by direction/state). */
export type TransferFilter = "all" | "downloading" | "uploading" | "completed" | "failed";

/**
 * Whether a view can still render given the currently-connected account ids.
 * `browse` and `review` views are pinned to one account; if it was removed they
 * can't render (a review would stream from a deleted remote and error out), so
 * loadAccounts() uses this to reset the current view and prune Back/Forward
 * history. Views not bound to an account (home/accounts/downloads/uploads) are
 * always valid. Pure, so it's unit-testable without the store.
 */
export function viewValidForAccounts(v: View, accountIds: Set<string>): boolean {
  if (v.kind === "browse" || v.kind === "review") return accountIds.has(v.accountId);
  return true;
}

/** A video file opened in the review player. */
export interface ReviewTarget {
  path: string;
  name: string;
  /** Backend file id — required for Drive/Drive-link streaming (empty otherwise). */
  fileId: string;
  size: number;
  ext: string;
}

/** Cap on the back/forward history so a long session can't grow unbounded. */
const HISTORY_CAP = 100;

/** Structural equality so a no-op navigation (clicking the folder you're
 *  already in) never records a duplicate history entry. Views are small. */
function sameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface AppState {
  view: View;
  /** Back/forward navigation stacks (most-recent at the ends nearest `view`). */
  back: View[];
  forward: View[];
  accounts: Account[];
  accountsLoaded: boolean;

  setView: (view: View) => void;
  /** Go to the previous / next view in history. No-ops when the stack is empty. */
  goBack: () => void;
  goForward: () => void;
  /** Go up one folder (browse views only). */
  goUp: () => void;
  /** Open the dashboard / home view. */
  showHome: () => void;
  selectAccount: (accountId: string) => void;
  openReview: (accountId: string, target: ReviewTarget) => void;
  showDownloads: (filter: DownloadFilter) => void;
  /** Open the Uploads view (local → cloud transfers). */
  showUploads: (filter: DownloadFilter) => void;
  /** Open the unified Transfers screen (optionally pre-filtered). */
  showTransfers: (filter?: TransferFilter) => void;
  showNewFolders: () => void;
  /** Open the GENERAL / WEB DOWNLOADS view (secondary-lane http/ytdlp jobs). */
  showWebDownloads: () => void;
  /** Pin (or, with undefined, clear) one web download in the detail panel. */
  openWebDownloadDetail: (id: string | undefined) => void;
  /** Set the category filter on the web downloads view. */
  setWebCategory: (category: WebCategoryFilter) => void;
  setSection: (section: Section) => void;
  setPath: (path: string) => void;
  loadAccounts: () => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
}

export const useApp = create<AppState>((set, get) => {
  // Record a navigation: push the current view onto `back`, clear `forward`.
  // All user-initiated navigation funnels through here (setView + the helpers
  // below), so ONE interception point captures folder dives, breadcrumb jumps,
  // account switches, section changes, and search → result → folder moves.
  const navTo = (s: AppState, view: View): Partial<AppState> => {
    if (sameView(s.view, view)) return {};
    return { view, back: [...s.back, s.view].slice(-HISTORY_CAP), forward: [] };
  };

  return {
  view: { kind: "accounts" },
  back: [],
  forward: [],
  accounts: [],
  accountsLoaded: false,

  setView: (view) => set((s) => navTo(s, view)),

  goBack: () =>
    set((s) => {
      if (s.back.length === 0) return {};
      const prev = s.back[s.back.length - 1];
      return { view: prev, back: s.back.slice(0, -1), forward: [s.view, ...s.forward].slice(0, HISTORY_CAP) };
    }),

  goForward: () =>
    set((s) => {
      if (s.forward.length === 0) return {};
      const next = s.forward[0];
      return { view: next, forward: s.forward.slice(1), back: [...s.back, s.view].slice(-HISTORY_CAP) };
    }),

  goUp: () =>
    set((s) => {
      if (s.view.kind !== "browse" || !s.view.path) return {};
      const parent = s.view.path.split("/").slice(0, -1).join("/");
      return navTo(s, { ...s.view, path: parent });
    }),

  showHome: () => set((s) => navTo(s, { kind: "home" })),

  selectAccount: (accountId) => set((s) => navTo(s, { kind: "browse", accountId, section: "all", path: "" })),

  openReview: (accountId, target) => set((s) => navTo(s, { kind: "review", accountId, target })),

  showTransfers: (filter = "all") => set((s) => navTo(s, { kind: "transfers", filter })),

  // The old download/upload/web entry points now all land on the unified
  // Transfers screen, pre-filtered by direction/state.
  showDownloads: (filter) =>
    set((s) => navTo(s, { kind: "transfers", filter: filter === "active" ? "downloading" : filter })),

  showUploads: () => set((s) => navTo(s, { kind: "transfers", filter: "uploading" })),

  showNewFolders: () => set((s) => navTo(s, { kind: "new-folders" })),

  showWebDownloads: () => set((s) => navTo(s, { kind: "transfers", filter: "all" })),

  // Sub-view state (detail panel / category filter) — not recorded in history,
  // so Back doesn't get cluttered with panel toggles.
  openWebDownloadDetail: (id) =>
    set((s) =>
      s.view.kind === "downloads" && s.view.web ? { view: { ...s.view, detail: id } } : s,
    ),

  setWebCategory: (category) =>
    set((s) =>
      s.view.kind === "downloads" && s.view.web
        ? { view: { ...s.view, category, detail: undefined } }
        : { view: { kind: "downloads", filter: "all", web: true, category } },
    ),

  setSection: (section) =>
    set((s) => (s.view.kind === "browse" ? navTo(s, { ...s.view, section, path: "" }) : {})),

  setPath: (path) => set((s) => (s.view.kind === "browse" ? navTo(s, { ...s.view, path }) : {})),

  loadAccounts: async () => {
    const accounts = await listAccounts();
    set((s) => {
      // When the set of accounts changes (add/remove), drop the all-drives
      // search cache so hits for a removed drive can't linger and navigate to a
      // dead account.
      const prevIds = s.accounts.map((a) => a.id).join(",");
      const nextIds = accounts.map((a) => a.id).join(",");
      if (prevIds !== nextIds) useGlobalSearch.getState().invalidateCache();
      let view = s.view;
      const first = (): View => ({ kind: "browse", accountId: accounts[0].id, section: "all", path: "" });
      if (accounts.length === 0) {
        view = { kind: "accounts" };
      } else if (view.kind === "accounts") {
        // First load with accounts present → land on the dashboard.
        view = { kind: "home" };
      }
      // Both browse AND review views are pinned to an account; if that account
      // was removed, they can no longer render (a review would try to stream
      // from a deleted rclone remote and fall into an error screen). Reset the
      // current view and drop such entries from Back/Forward history.
      const ids = new Set(accounts.map((a) => a.id));
      const valid = (v: View) => viewValidForAccounts(v, ids);
      if (!valid(view)) view = first();
      return { accounts, accountsLoaded: true, view, back: s.back.filter(valid), forward: s.forward.filter(valid) };
    });
  },

  removeAccount: async (id) => {
    const acct = get().accounts.find((a) => a.id === id);
    await removeAccount(id);
    await useIndex.getState().remove(id);
    await get().loadAccounts();
    useToasts.getState().push(`Removed ${acct ? prettyLabel(acct.label) : "account"}`, "success");
  },
  };
});
