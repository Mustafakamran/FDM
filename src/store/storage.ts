import { create } from "zustand";
import { RcClient } from "../lib/rc/client";
import { buildFs } from "../lib/rc/browse";
import type { Account } from "../lib/tauri/commands";

export interface Storage {
  used: number;
  total: number;
}

interface StorageState {
  byAccount: Record<string, Storage>;
  fetch: (account: Account) => Promise<void>;
}

export const useStorage = create<StorageState>((set, get) => ({
  byAccount: {},
  fetch: async (account) => {
    if (get().byAccount[account.id]) return;
    try {
      const r = await new RcClient().call<{ used?: number; total?: number }>("operations/about", {
        fs: buildFs(account),
      });
      if (r && (typeof r.total === "number" || typeof r.used === "number")) {
        set((s) => ({
          byAccount: { ...s.byAccount, [account.id]: { used: r.used ?? 0, total: r.total ?? 0 } },
        }));
      }
    } catch {
      /* some backends don't support about — leave it unset */
    }
  },
}));
