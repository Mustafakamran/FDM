import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persisted";

/** A manual, user-set workflow status on a folder (or file). */
export type FolderStatus = "downloading" | "on_hold" | "downloaded" | "copied";

/** Ordered for the context menu + their badge colors (accent-aware where it fits). */
export const FOLDER_STATUS_META: Record<FolderStatus, { label: string; color: string; bg: string }> = {
  downloading: { label: "Downloading", color: "var(--accent)", bg: "var(--accent-weak)" },
  on_hold: { label: "On hold", color: "var(--warning)", bg: "color-mix(in srgb, var(--warning) 14%, transparent)" },
  downloaded: { label: "Downloaded", color: "var(--success)", bg: "color-mix(in srgb, var(--success) 14%, transparent)" },
  copied: { label: "Copied", color: "var(--text-2)", bg: "var(--soft)" },
};

export const FOLDER_STATUS_ORDER: FolderStatus[] = ["downloading", "on_hold", "downloaded", "copied"];

const KEY = "folder_status_v1";
type StatusMap = Record<string, Record<string, FolderStatus>>; // accountId → path → status

interface FolderStatusState {
  byAccount: StatusMap;
  /** Set (or, with null, clear) the status of an account's folder path. */
  set: (accountId: string, path: string, status: FolderStatus | null) => void;
}

export const useFolderStatus = create<FolderStatusState>((set) => ({
  byAccount: loadJson<StatusMap>(KEY, {}),
  set: (accountId, path, status) =>
    set((s) => {
      const acct = { ...(s.byAccount[accountId] ?? {}) };
      if (status) acct[path] = status;
      else delete acct[path];
      const byAccount = { ...s.byAccount, [accountId]: acct };
      saveJson(KEY, byAccount);
      return { byAccount };
    }),
}));

/** Read a folder's status outside React (selectors use the hook directly). */
export function folderStatusOf(byAccount: StatusMap, accountId: string, path: string): FolderStatus | undefined {
  return byAccount[accountId]?.[path];
}
