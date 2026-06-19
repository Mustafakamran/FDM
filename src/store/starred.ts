import { create } from "zustand";

const KEY = "starred_v1";

function load(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

interface StarState {
  byAccount: Record<string, string[]>;
  toggle: (accountId: string, path: string) => void;
  isStarred: (accountId: string, path: string) => boolean;
}

export const useStarred = create<StarState>((set, get) => ({
  byAccount: load(),

  toggle: (accountId, path) =>
    set((s) => {
      const cur = s.byAccount[accountId] ?? [];
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
      const byAccount = { ...s.byAccount, [accountId]: next };
      try {
        localStorage.setItem(KEY, JSON.stringify(byAccount));
      } catch {
        /* ignore quota errors */
      }
      return { byAccount };
    }),

  isStarred: (accountId, path) => (get().byAccount[accountId] ?? []).includes(path),
}));
