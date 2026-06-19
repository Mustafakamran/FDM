import { create } from "zustand";
import { listAccounts, removeAccount, type Account } from "../lib/tauri/commands";
import { useIndex } from "./index-store";

export type Section = "all" | "recent" | "starred" | "shared";

export type View =
  | { kind: "browse"; accountId: string; section: Section; path: string }
  | { kind: "settings" }
  | { kind: "accounts" };

interface AppState {
  view: View;
  accounts: Account[];
  accountsLoaded: boolean;

  setView: (view: View) => void;
  selectAccount: (accountId: string) => void;
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
    await removeAccount(id);
    await useIndex.getState().remove(id);
    await get().loadAccounts();
  },
}));
