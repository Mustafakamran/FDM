import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { RcItem } from "../lib/rc/browse";

/** A search hit tagged with the drive it came from (added by the Rust
 *  `search_all_accounts` command). */
export type GlobalHit = RcItem & { AccountId?: string; Provider?: string };

interface GlobalSearchState {
  results: GlobalHit[];
  loading: boolean;
  error?: string;
  /** Debounced, cached, cancellable search across ALL connected drives. */
  run: (query: string) => void;
  clear: () => void;
}

// Same "feels instant" recipe as per-account search: short debounce, a
// per-query cache so re-typing resolves with no round-trip, and a single
// supersede token so a slower older query can't overwrite a newer one.
const DEBOUNCE_MS = 200;
const cache = new Map<string, GlobalHit[]>();
let timer: ReturnType<typeof setTimeout> | undefined;
let token = 0;

export const useGlobalSearch = create<GlobalSearchState>((set) => ({
  results: [],
  loading: false,
  error: undefined,

  run: (query) => {
    const q = query.trim();
    if (!q) {
      token++;
      if (timer) clearTimeout(timer);
      set({ results: [], loading: false, error: undefined });
      return;
    }
    const cached = cache.get(q.toLowerCase());
    // Cached result shows instantly; a background refresh still runs below.
    set({ results: cached ?? [], loading: cached === undefined, error: undefined });

    if (timer) clearTimeout(timer);
    const myToken = ++token;
    timer = setTimeout(() => {
      void invoke<GlobalHit[]>("search_all_accounts", { query: q })
        .then((items) => {
          if (myToken !== token) return; // superseded by a newer query
          cache.set(q.toLowerCase(), items);
          set({ results: items, loading: false, error: undefined });
        })
        .catch((e) => {
          if (myToken !== token) return;
          set({ loading: false, error: String(e) });
        });
    }, DEBOUNCE_MS);
  },

  clear: () => {
    token++;
    if (timer) clearTimeout(timer);
    set({ results: [], loading: false, error: undefined });
  },
}));
