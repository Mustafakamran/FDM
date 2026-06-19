import { create } from "zustand";
import { accountEmail } from "../lib/tauri/commands";

const KEY = "account_meta_v1";

interface Meta {
  label?: string; // original (cased) label the user typed
  email?: string; // signed-in account email
}

function load(): Record<string, Meta> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

function persist(byId: Record<string, Meta>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(byId));
  } catch {
    /* ignore quota */
  }
}

/** Best-effort display name from a slug when no original label was saved. */
export function prettyLabel(slug: string): string {
  return slug
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const inflight = new Set<string>();

interface MetaState {
  byId: Record<string, Meta>;
  setLabel: (id: string, label: string) => void;
  fetchEmail: (id: string) => Promise<void>;
}

export const useAccountMeta = create<MetaState>((set, get) => ({
  byId: load(),

  setLabel: (id, label) =>
    set((s) => {
      const byId = { ...s.byId, [id]: { ...s.byId[id], label } };
      persist(byId);
      return { byId };
    }),

  fetchEmail: async (id) => {
    if (get().byId[id]?.email || inflight.has(id)) return;
    inflight.add(id);
    try {
      const email = await accountEmail(id);
      if (email)
        set((s) => {
          const byId = { ...s.byId, [id]: { ...s.byId[id], email } };
          persist(byId);
          return { byId };
        });
    } catch {
      /* best-effort */
    } finally {
      inflight.delete(id);
    }
  },
}));
