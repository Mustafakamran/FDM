import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listFolder, folderSize, type RcItem } from "../lib/rc/browse";
import type { Account } from "../lib/tauri/commands";
import { loadJson, saveJson } from "../lib/persisted";

/** Folder size value: a byte count, or a status sentinel. */
export type SizeValue = number | "loading" | "error";

const key = (accountId: string, path: string) => `${accountId} ${path}`;

// Persisted folder-listing cache (LRU). The in-memory `listings` map already
// makes re-opening a folder instant WITHIN a session; hydrating it from disk
// on launch extends that to "instant across restarts" — the cached rows paint
// immediately and ensure() silently refreshes them (stale-while-revalidate).
// Bounded hard: skip enormous folders and cap how many are kept, so a footage
// library can never blow the localStorage quota.
const LISTING_CACHE_KEY = "browse_listings_v1";
const LISTING_CACHE_CAP = 30; // folders
const LISTING_ITEM_MAX = 400; // don't persist folders bigger than this
const LISTING_SAVE_DEBOUNCE_MS = 1000;
type ListingEntry = { k: string; items: RcItem[] };

// The cache lives in memory (parsed ONCE at startup) and is written back on a
// trailing debounce — so navigating folders never re-parses or re-serializes
// the whole multi-MB cache on the main thread per navigation (that write
// amplification would defeat the "instant navigation" goal). MRU: newest last.
let cacheArr: ListingEntry[] = loadJson<ListingEntry[]>(LISTING_CACHE_KEY, []);
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleCacheSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      saveJson(LISTING_CACHE_KEY, cacheArr);
    } catch {
      /* quota exceeded or serialization error — the cache is best-effort */
    }
  }, LISTING_SAVE_DEBOUNCE_MS);
}

function loadPersistedListings(): Record<string, RcItem[]> {
  const rec: Record<string, RcItem[]> = {};
  for (const e of cacheArr) rec[e.k] = e.items;
  return rec;
}

function persistListing(k: string, items: RcItem[]): void {
  // Always drop any existing entry for this key first, so a folder that has
  // grown past the item cap can't leave a stale smaller snapshot behind to be
  // hydrated as if current on the next launch.
  const i = cacheArr.findIndex((e) => e.k === k);
  if (i !== -1) cacheArr.splice(i, 1);
  if (items.length <= LISTING_ITEM_MAX) {
    cacheArr.push({ k, items }); // most-recently-used at the end
    while (cacheArr.length > LISTING_CACHE_CAP) cacheArr.shift();
  }
  scheduleCacheSave();
}
const inflightList = new Set<string>();
const inflightSize = new Set<string>();

// Live search/recent feels "instant" the way Drive/Dropbox's own web search
// does by combining three things: (1) a short debounce so fast typing doesn't
// fire a request per keystroke, (2) a result cache so re-typing a query
// already seen this session resolves with zero network round-trip, and (3) a
// stale-while-revalidate render — the previous result list stays on screen
// while a fresher one loads, instead of flashing to empty every keystroke.
const SEARCH_DEBOUNCE_MS = 180;
const searchKey = (accountId: string, query: string) => `${accountId}::q::${query.toLowerCase()}`;
const recentKey = (accountId: string) => `${accountId}::recent`;
const searchTimers = new Map<string, ReturnType<typeof setTimeout>>();
// One token per account: a debounced fetch only applies if it's still the
// most recently requested one for that account (guards a slower, older
// request resolving after a newer one already has).
const searchTokens = new Map<string, number>();
const inflightRecent = new Set<string>();

interface BrowseState {
  listings: Record<string, RcItem[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  sizes: Record<string, SizeValue>;
  searchResults: Record<string, RcItem[]>;
  searchLoading: Record<string, boolean>;
  searchErrors: Record<string, string | undefined>;

  /** Load a folder; returns cached instantly and refreshes in the background. */
  ensure: (account: Account, path: string) => Promise<void>;
  /** Lazily compute + cache a folder's recursive size. */
  computeSize: (account: Account, path: string) => Promise<void>;
  /** Debounced, cached live search (Drive files.list / Dropbox search_v2). */
  search: (account: Account, query: string) => void;
  /** Debounced, cached live "recent files" (Drive only). */
  recent: (account: Account) => void;
}

export const useBrowse = create<BrowseState>((set, get) => ({
  listings: loadPersistedListings(),
  loading: {},
  errors: {},
  sizes: {},
  searchResults: {},
  searchLoading: {},
  searchErrors: {},

  // `force` doesn't gate any fetch logic below — every call already refreshes
  // in the background regardless (this returns cached data instantly for
  // display while a fresh fetch runs; there's nothing left to "force"). It's
  // kept in the signature purely so a "Retry" button reads as intentional at
  // the call site.
  ensure: async (account, path) => {
    const k = key(account.id, path);
    // Dropbox links have no rclone remote — the Rust index is their only source.
    // Don't fall through to a live rclone list (it would hit a missing remote).
    if (account.id.startsWith("dropboxlink_")) {
      set((s) => ({ loading: { ...s.loading, [k]: false } }));
      return;
    }
    const cached = get().listings[k];
    // Show cached immediately; only flip the spinner when we have nothing.
    if (cached === undefined) set((s) => ({ loading: { ...s.loading, [k]: true } }));
    if (inflightList.has(k)) return;
    inflightList.add(k);
    // Retry once after a short delay — the most common failure is the rclone
    // daemon not being ready yet right after launch.
    let lastErr: unknown;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const items = await listFolder(account, path);
          set((s) => ({
            listings: { ...s.listings, [k]: items },
            loading: { ...s.loading, [k]: false },
            errors: { ...s.errors, [k]: undefined },
          }));
          persistListing(k, items);
          return;
        } catch (e) {
          lastErr = e;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
        }
      }
      set((s) => ({
        loading: { ...s.loading, [k]: false },
        errors: { ...s.errors, [k]: String(lastErr) },
      }));
    } finally {
      inflightList.delete(k);
    }
  },

  // Lazy folder sizes run through a small concurrency-limited queue: recursive
  // size walks (operations/size) are heavy, so computing them for every visible
  // folder at once would hammer the rclone daemon. Capped at MAX_SIZE_CONCURRENCY.
  computeSize: (account, path) =>
    new Promise<void>((resolve) => {
      const k = key(account.id, path);
      const existing = get().sizes[k];
      if (existing !== undefined && existing !== "error") return resolve(); // have it or computing
      if (inflightSize.has(k)) return resolve();
      inflightSize.add(k);
      set((s) => ({ sizes: { ...s.sizes, [k]: "loading" } }));
      sizeQueue.push({ account, path, done: resolve });
      pumpSizes(set);
    }),

  search: (account, query) => {
    const q = query.trim();
    const k = searchKey(account.id, q);
    if (!q) return;
    // Cached result (this session) shows instantly; a background refresh
    // still runs below so it stays fresh without ever looking empty.
    const cached = get().searchResults[k];
    set((s) => ({ searchLoading: { ...s.searchLoading, [k]: cached === undefined } }));

    const existingTimer = searchTimers.get(account.id);
    if (existingTimer) clearTimeout(existingTimer);
    const myToken = (searchTokens.get(account.id) ?? 0) + 1;
    searchTokens.set(account.id, myToken);
    const timer = setTimeout(() => {
      void invoke<RcItem[]>("account_search", { accountId: account.id, query: q })
        .then((items) => {
          if (searchTokens.get(account.id) !== myToken) return; // superseded by a newer query
          set((s) => ({
            searchResults: { ...s.searchResults, [k]: items },
            searchLoading: { ...s.searchLoading, [k]: false },
            searchErrors: { ...s.searchErrors, [k]: undefined },
          }));
        })
        .catch((e) => {
          if (searchTokens.get(account.id) !== myToken) return;
          set((s) => ({
            searchLoading: { ...s.searchLoading, [k]: false },
            searchErrors: { ...s.searchErrors, [k]: String(e) },
          }));
        });
    }, SEARCH_DEBOUNCE_MS);
    searchTimers.set(account.id, timer);
  },

  recent: (account) => {
    const k = recentKey(account.id);
    const cached = get().searchResults[k];
    set((s) => ({ searchLoading: { ...s.searchLoading, [k]: cached === undefined } }));
    if (inflightRecent.has(k)) return;
    inflightRecent.add(k);
    void invoke<RcItem[]>("account_recent", { accountId: account.id })
      .then((items) => {
        set((s) => ({
          searchResults: { ...s.searchResults, [k]: items },
          searchLoading: { ...s.searchLoading, [k]: false },
          searchErrors: { ...s.searchErrors, [k]: undefined },
        }));
      })
      .catch((e) => {
        set((s) => ({
          searchLoading: { ...s.searchLoading, [k]: false },
          searchErrors: { ...s.searchErrors, [k]: String(e) },
        }));
      })
      .finally(() => inflightRecent.delete(k));
  },
}));

export const browseSearchKey = searchKey;
export const browseRecentKey = recentKey;

const MAX_SIZE_CONCURRENCY = 3;
const sizeQueue: { account: Account; path: string; done: () => void }[] = [];
let activeSizes = 0;

function pumpSizes(set: (fn: (s: BrowseState) => Partial<BrowseState>) => void) {
  while (activeSizes < MAX_SIZE_CONCURRENCY && sizeQueue.length > 0) {
    const job = sizeQueue.shift()!;
    const k = key(job.account.id, job.path);
    activeSizes++;
    void (async () => {
      try {
        const { bytes } = await folderSize(job.account, job.path);
        set((s) => ({ sizes: { ...s.sizes, [k]: bytes } }));
      } catch {
        set((s) => ({ sizes: { ...s.sizes, [k]: "error" } }));
      } finally {
        inflightSize.delete(k);
        activeSizes--;
        job.done();
        pumpSizes(set);
      }
    })();
  }
}

export const browseKey = key;
