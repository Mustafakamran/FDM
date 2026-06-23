import { create } from "zustand";
import { listAccounts, removeAccount, type Account } from "../lib/tauri/commands";
import { useIndex } from "./index-store";
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
  | { kind: "review"; accountId: string; target: ReviewTarget }
  | { kind: "accounts" };

export type DownloadFilter = "all" | "active" | "completed" | "failed";

/** A video file opened in the review player. */
export interface ReviewTarget {
  path: string;
  name: string;
  /** Backend file id — required for Drive/Drive-link streaming (empty otherwise). */
  fileId: string;
  size: number;
  ext: string;
}

interface AppState {
  view: View;
  accounts: Account[];
  accountsLoaded: boolean;

  setView: (view: View) => void;
  selectAccount: (accountId: string) => void;
  openReview: (accountId: string, target: ReviewTarget) => void;
  showDownloads: (filter: DownloadFilter) => void;
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

export const useApp = create<AppState>((set, get) => ({
  view: { kind: "accounts" },
  accounts: [],
  accountsLoaded: false,

  setView: (view) => set({ view }),

  selectAccount: (accountId) => set({ view: { kind: "browse", accountId, section: "all", path: "" } }),

  openReview: (accountId, target) => set({ view: { kind: "review", accountId, target } }),

  showDownloads: (filter) => set({ view: { kind: "downloads", filter } }),

  showWebDownloads: () => set({ view: { kind: "downloads", filter: "all", web: true, category: "All" } }),

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
    set((s) =>
      s.view.kind === "browse" ? { view: { ...s.view, section, path: "" } } : s,
    ),

  setPath: (path) => set((s) => (s.view.kind === "browse" ? { view: { ...s.view, path } } : s)),

  loadAccounts: async () => {
    const accounts = await listAccounts();
    set((s) => {
      let view = s.view;
      const first = (): View => ({ kind: "browse", accountId: accounts[0].id, section: "all", path: "" });
      if (accounts.length === 0) {
        view = { kind: "accounts" };
      } else if (view.kind === "accounts") {
        view = first();
      } else if (view.kind === "browse") {
        const id = view.accountId;
        if (!accounts.some((a) => a.id === id)) view = first();
      }
      return { accounts, accountsLoaded: true, view };
    });
  },

  removeAccount: async (id) => {
    const acct = get().accounts.find((a) => a.id === id);
    await removeAccount(id);
    await useIndex.getState().remove(id);
    await get().loadAccounts();
    useToasts.getState().push(`Removed ${acct ? prettyLabel(acct.label) : "account"}`, "success");
  },
}));
