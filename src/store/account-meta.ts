import { create } from "zustand";
import { accountEmail } from "../lib/tauri/commands";
import { loadJson, saveJson } from "../lib/persisted";

const KEY = "account_meta_v1";

export interface Meta {
  label?: string; // original (cased) label the user typed
  email?: string; // signed-in account email
}

const load = () => loadJson<Record<string, Meta>>(KEY, {});
const persist = (byId: Record<string, Meta>) => saveJson(KEY, byId);

/** Best-effort display name from a slug when no original label was saved. */
export function prettyLabel(slug: string): string {
  return slug
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * An account's display label: the user's original-cased name (`Meta.label`,
 * set via the Add Account/Link dialog) if one was saved, else a best-effort
 * reconstruction from the account's slug (`Account.label`, the sanitized
 * rclone remote name). One place for the fallback so it can't drift across
 * the several components that show an account's name.
 */
export function accountLabel(metaLabel: string | undefined, account: { label: string }): string {
  return metaLabel ?? prettyLabel(account.label);
}

const inflight = new Set<string>();

interface MetaState {
  byId: Record<string, Meta>;
  errors: Record<string, string>;
  setLabel: (id: string, label: string) => void;
  fetchEmail: (id: string, force?: boolean) => Promise<void>;
}

export const useAccountMeta = create<MetaState>((set, get) => ({
  byId: load(),
  errors: {},

  setLabel: (id, label) =>
    set((s) => {
      const byId = { ...s.byId, [id]: { ...s.byId[id], label } };
      persist(byId);
      return { byId };
    }),

  fetchEmail: async (id, force = false) => {
    if ((get().byId[id]?.email && !force) || inflight.has(id)) return;
    inflight.add(id);
    set((s) => ({ errors: { ...s.errors, [id]: "" } }));
    try {
      const email = await accountEmail(id);
      if (email) {
        set((s) => {
          const byId = { ...s.byId, [id]: { ...s.byId[id], email } };
          persist(byId);
          return { byId };
        });
      } else {
        set((s) => ({ errors: { ...s.errors, [id]: "no email returned (Dropbox needs the account_info.read scope)" } }));
      }
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: String(e) } }));
    } finally {
      inflight.delete(id);
    }
  },
}));
