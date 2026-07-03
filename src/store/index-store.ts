import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  indexStart,
  indexRecrawl,
  indexGet,
  indexRemove,
  indexFolder,
  indexCancel,
  removeFromIndex,
  type AccountIndex,
} from "../lib/account-index";
import type { Account } from "../lib/tauri/commands";
import { useToasts } from "./toast";

export type IndexStatus = "idle" | "loading" | "crawling" | "ready" | "error";

/**
 * Live crawl progress. done/total = FOLDERS processed/discovered-so-far.
 * bytes/dateMin/dateMax are additive (extended from the original {done,total,files})
 * and optional so older payloads / seeded entries stay valid.
 */
export interface IndexProgressData {
  done: number;
  total: number;
  files: number;
  bytes?: number;
  dateMin?: string; // ISO modTime ("" when none)
  dateMax?: string; // ISO modTime ("" when none)
}

export interface IndexEntry {
  status: IndexStatus;
  progress: IndexProgressData;
  index: AccountIndex | null;
  error?: string;
}

interface IndexState {
  byAccount: Record<string, IndexEntry>;
  ensure: (account: Account) => Promise<void>;
  /** Like ensure(), but a no-op once the user has cancelled this account's
   *  auto-crawl — so navigating away and back never silently restarts it. */
  ensureAuto: (account: Account) => Promise<void>;
  recrawl: (account: Account) => Promise<void>;
  indexFolder: (account: Account, folderPath: string) => Promise<void>;
  cancel: (accountId: string) => Promise<void>;
  remove: (accountId: string) => Promise<void>;
  /** Optimistically drop a deleted file/folder from the cached index. */
  dropPath: (accountId: string, path: string) => void;
}

// Accounts whose background auto-index the user explicitly cancelled this
// session. cancel() settles status back to "idle", which the auto-index effect
// would otherwise treat as "never crawled" and restart on the next mount — so
// ensureAuto() honors this set. An explicit user action (ensure/recrawl/
// indexFolder) clears it, and remove() drops it with the account.
const autoIndexCancelled = new Set<string>();

const blankProgress = (): IndexProgressData => ({ done: 0, total: 0, files: 0, bytes: 0, dateMin: "", dateMax: "" });

const blank = (): IndexEntry => ({ status: "idle", progress: blankProgress(), index: null });

export const useIndex = create<IndexState>((set, get) => {
  // Register the Rust → JS index events exactly once.
  let listeners: Promise<void> | null = null;
  const patch = (id: string, e: Partial<IndexEntry>) =>
    set((s) => ({ byAccount: { ...s.byAccount, [id]: { ...(s.byAccount[id] ?? blank()), ...e } } }));

  function ensureListeners(): Promise<void> {
    if (listeners) return listeners;
    listeners = (async () => {
      try {
        await listen<{
          accountId: string;
          done: number;
          total: number;
          files: number;
          bytes: number;
          dateMin: string;
          dateMax: string;
        }>("index-progress", (ev) => {
          const { accountId, done, total, files, bytes, dateMin, dateMax } = ev.payload;
          patch(accountId, {
            status: total > 0 ? "crawling" : "loading",
            progress: {
              done: done ?? 0,
              total: total ?? 0,
              files: files ?? 0,
              bytes: bytes ?? 0,
              dateMin: dateMin ?? "",
              dateMax: dateMax ?? "",
            },
          });
        });
        await listen<{ accountId: string }>("index-ready", async (ev) => {
          // Only toast when a crawl was actually in progress — not on the silent
          // cached-index load that happens on every account open.
          const wasCrawling = get().byAccount[ev.payload.accountId]?.status === "crawling";
          const idx = await indexGet(ev.payload.accountId);
          patch(ev.payload.accountId, { status: "ready", progress: blankProgress(), index: idx, error: undefined });
          if (wasCrawling) {
            const files = idx?.tree
              ? Object.values(idx.tree).reduce((n, arr) => n + arr.filter((i) => !i.IsDir).length, 0)
              : 0;
            useToasts.getState().push(`Index complete · ${files.toLocaleString()} files`, "success");
          }
        });
        await listen<{ accountId: string; error: string }>("index-error", (ev) => {
          patch(ev.payload.accountId, { status: "error", error: ev.payload.error });
        });
      } catch {
        /* no Tauri event runtime (e.g. unit tests) */
      }
    })();
    return listeners;
  }

  return {
    byAccount: {},

    ensure: async (account) => {
      autoIndexCancelled.delete(account.id); // an explicit start re-enables auto
      const cur = get().byAccount[account.id];
      if (cur && cur.status !== "idle" && cur.status !== "error") return;
      await ensureListeners();
      patch(account.id, { status: "loading" });
      await indexStart(account.id).catch((e) => patch(account.id, { status: "error", error: String(e) }));
    },

    ensureAuto: async (account) => {
      if (autoIndexCancelled.has(account.id)) return; // user stopped it; don't restart
      await get().ensure(account);
    },

    recrawl: async (account) => {
      autoIndexCancelled.delete(account.id);
      await ensureListeners();
      patch(account.id, { status: "loading", index: get().byAccount[account.id]?.index ?? null });
      await indexRecrawl(account.id).catch((e) => patch(account.id, { status: "error", error: String(e) }));
    },

    indexFolder: async (account, folderPath) => {
      autoIndexCancelled.delete(account.id);
      await ensureListeners();
      // Keep the current index visible — the backend merges this subtree in.
      patch(account.id, {
        status: "crawling",
        progress: blankProgress(),
        index: get().byAccount[account.id]?.index ?? null,
        error: undefined,
      });
      await indexFolder(account.id, folderPath).catch((e) => patch(account.id, { status: "error", error: String(e) }));
    },

    cancel: async (accountId) => {
      // Remember the user stopped this one so ensureAuto() won't restart it.
      autoIndexCancelled.add(accountId);
      // Optimistically settle the UI; a final index-ready/index-error still lands if the crawl flushes.
      const cur = get().byAccount[accountId];
      patch(accountId, { status: cur?.index ? "ready" : "idle", progress: blankProgress() });
      await indexCancel(accountId).catch(() => {});
    },

    remove: async (accountId) => {
      autoIndexCancelled.delete(accountId);
      await indexRemove(accountId).catch(() => {});
      set((s) => {
        const b = { ...s.byAccount };
        delete b[accountId];
        return { byAccount: b };
      });
    },

    dropPath: (accountId, path) =>
      set((s) => {
        const e = s.byAccount[accountId];
        if (!e?.index) return s;
        return { byAccount: { ...s.byAccount, [accountId]: { ...e, index: removeFromIndex(e.index, path) } } };
      }),
  };
});
