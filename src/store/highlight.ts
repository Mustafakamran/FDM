import { create } from "zustand";

interface HighlightState {
  /** The account + path of a file/folder to flash + select once the browse view
   *  lands on it (e.g. after jumping from a search result). Consumed and cleared
   *  by BrowsePane. */
  accountId: string | null;
  path: string | null;
  set: (accountId: string, path: string) => void;
  clear: () => void;
}

export const useHighlight = create<HighlightState>((set) => ({
  accountId: null,
  path: null,
  set: (accountId, path) => set({ accountId, path }),
  clear: () => set({ accountId: null, path: null }),
}));
