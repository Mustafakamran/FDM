import { create } from "zustand";

/** Where a query looks: the folder you're in, the whole current drive, or every drive. */
export type SearchScope = "folder" | "drive" | "all";

interface SearchState {
  q: string;
  /** User-chosen scope override; null means "use the context-aware default"
   *  (folder when browsing a folder, drive at a drive root, all on Home). */
  scopeOverride: SearchScope | null;
  /** Bumped when Cmd/Ctrl+K is pressed so the top-bar search input focuses —
   *  the command palette and the search box are one and the same now. */
  focusSeq: number;
  set: (q: string) => void;
  setScope: (s: SearchScope | null) => void;
  /** Request focus on the search input (Cmd+K). */
  focus: () => void;
}

export const useSearch = create<SearchState>((set, get) => ({
  q: "",
  scopeOverride: null,
  focusSeq: 0,
  // Clearing the query drops any manual scope so the next search starts from the
  // context-aware default again.
  set: (q) => set(q.trim() ? { q } : { q, scopeOverride: null }),
  setScope: (scopeOverride) => set({ scopeOverride }),
  focus: () => set({ focusSeq: get().focusSeq + 1 }),
}));
