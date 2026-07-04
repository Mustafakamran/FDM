import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persisted";

const KEY = "account_order_v1";

interface AccountOrderState {
  /** Persisted account-id order for the sidebar. Ids not present sort to the end. */
  order: string[];
  /** Move an account up (-1) or down (+1) within the current full id list. */
  move: (id: string, dir: -1 | 1, allIds: string[]) => void;
}

export const useAccountOrder = create<AccountOrderState>((set, get) => ({
  order: loadJson<string[]>(KEY, []),

  move: (id, dir, allIds) => {
    // Reconcile saved order with the live account list: keep known ids in their
    // saved order, append any new ones, then swap the target with its neighbour.
    const cur = get().order.filter((x) => allIds.includes(x));
    for (const x of allIds) if (!cur.includes(x)) cur.push(x);
    const i = cur.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]];
    saveJson(KEY, cur);
    set({ order: cur });
  },
}));

/** Sort accounts by the saved order; unknown ids keep their relative order at the end. */
export function orderAccounts<T extends { id: string }>(accounts: T[], order: string[]): T[] {
  const idx = new Map(order.map((id, i) => [id, i] as const));
  return accounts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (idx.get(x.a.id) ?? 1e9 + x.i) - (idx.get(y.a.id) ?? 1e9 + y.i))
    .map((x) => x.a);
}
