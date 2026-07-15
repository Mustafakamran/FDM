import { getOrCreateDriveLink, type DownloadItem } from "./tauri/commands";
import { useApp } from "../store/app";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";

/**
 * A Google Drive folder-SHORTCUT can't be reached by name-path (its target lives
 * outside the `shared_with_me` namespace and folder names may contain `/`), so we
 * root a linked-folder account (`drivelink_*`, via get_or_create_drive_link) at
 * the target folder id — the same engine as "Add Drive link" — and browse/download
 * that. Reused across the browse pane and search results.
 */

/** Open a folder-shortcut's target as a linked folder and navigate into it. */
export async function openShortcutFolder(baseAccountId: string, label: string, folderId: string): Promise<void> {
  try {
    const acct = await getOrCreateDriveLink(baseAccountId, label, folderId);
    await useApp.getState().loadAccounts(); // surface the linked folder + make the view valid
    useApp.getState().setView({ kind: "browse", accountId: acct.id, section: "all", path: "" });
  } catch (e) {
    useToasts.getState().push(`Couldn’t open “${label}”: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Queue a whole folder-shortcut target for download (its linked-folder root). */
export async function downloadShortcutFolder(baseAccountId: string, label: string, folderId: string, dest: string): Promise<void> {
  try {
    const acct = await getOrCreateDriveLink(baseAccountId, label, folderId);
    await useApp.getState().loadAccounts();
    const item: DownloadItem = { path: "", name: label, isDir: true, size: 0, id: "" };
    useTransfers.getState().enqueue(acct.id, [item], dest);
    useToasts.getState().push(`Queued ${label}`, "success");
  } catch (e) {
    useToasts.getState().push(`Couldn’t download “${label}”: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
