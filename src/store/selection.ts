import { create } from "zustand";
import type { RcItem } from "../lib/rc/browse";

/** A selected item plus its resolved size (folders' sizes aren't on the RcItem). */
export interface SelectedItem {
  item: RcItem;
  size: number;
}

interface SelectionState {
  /** accountId → path → selected item. Persists across folder AND drive
   *  navigation so a selection can be built up across drives and downloaded
   *  together. In-memory only (a selection is a "right now" intent). */
  byAccount: Record<string, Record<string, SelectedItem>>;
  toggle: (accountId: string, entry: SelectedItem) => void;
  /** Add several (range-select / select-all) without clearing existing ones. */
  add: (accountId: string, entries: SelectedItem[]) => void;
  /** Replace an account's whole selection (used by the header select-all/none). */
  setAccount: (accountId: string, entries: SelectedItem[]) => void;
  remove: (accountId: string, path: string) => void;
  clearAccount: (accountId: string) => void;
  clearAll: () => void;
}

export const useSelection = create<SelectionState>((set) => ({
  byAccount: {},

  toggle: (accountId, entry) =>
    set((s) => {
      const cur = { ...(s.byAccount[accountId] ?? {}) };
      if (cur[entry.item.Path]) delete cur[entry.item.Path];
      else cur[entry.item.Path] = entry;
      return { byAccount: { ...s.byAccount, [accountId]: cur } };
    }),

  add: (accountId, entries) =>
    set((s) => {
      const cur = { ...(s.byAccount[accountId] ?? {}) };
      for (const e of entries) cur[e.item.Path] = e;
      return { byAccount: { ...s.byAccount, [accountId]: cur } };
    }),

  setAccount: (accountId, entries) =>
    set((s) => {
      const map: Record<string, SelectedItem> = {};
      for (const e of entries) map[e.item.Path] = e;
      return { byAccount: { ...s.byAccount, [accountId]: map } };
    }),

  remove: (accountId, path) =>
    set((s) => {
      const cur = { ...(s.byAccount[accountId] ?? {}) };
      delete cur[path];
      return { byAccount: { ...s.byAccount, [accountId]: cur } };
    }),

  clearAccount: (accountId) =>
    set((s) => ({ byAccount: { ...s.byAccount, [accountId]: {} } })),

  clearAll: () => set({ byAccount: {} }),
}));

/** Total selected count across every drive. */
export function totalSelectedCount(byAccount: Record<string, Record<string, SelectedItem>>): number {
  return Object.values(byAccount).reduce((n, m) => n + Object.keys(m).length, 0);
}

/** Total selected byte size across every drive (uses each item's resolved size). */
export function totalSelectedSize(byAccount: Record<string, Record<string, SelectedItem>>): number {
  let bytes = 0;
  for (const m of Object.values(byAccount)) for (const e of Object.values(m)) bytes += Math.max(0, e.size);
  return bytes;
}

/** How many distinct drives currently have a selection. */
export function selectedDriveCount(byAccount: Record<string, Record<string, SelectedItem>>): number {
  return Object.values(byAccount).filter((m) => Object.keys(m).length > 0).length;
}
