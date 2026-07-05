import { RcClient } from "./client";
import { resolveShortcut, type Account } from "../tauri/commands";

/** Google Drive shortcut mime type — rclone surfaces these unresolved. */
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

export interface RcItem {
  Name: string;
  Path: string;
  Size: number;
  IsDir: boolean;
  ModTime: string;
  MimeType: string;
  /** Backend file id (Drive populates this); used for uploader lookup. */
  ID?: string;
}

/**
 * rclone connection string for an account. Google Drive must surface
 * "Shared with me" (where clients drop footage), so we append the
 * shared_with_me connection parameter. Dropbox uses the plain remote.
 */
export function buildFs(account: Account): string {
  // Drive links are rooted at a folder id — list plainly, not "Shared with me".
  if (account.id.startsWith("drivelink_")) return `${account.id}:`;
  return account.provider === "drive"
    ? `${account.id},shared_with_me=true:`
    : `${account.id}:`;
}

export interface SizeResult {
  bytes: number;
  count: number;
}

/**
 * Recursively compute a folder's total size via rclone (Drive/Dropbox don't
 * expose it). NOTE: `operations/size` sizes the ENTIRE `fs` and ignores any
 * `remote` subpath — so the folder path MUST be folded into the fs connection
 * string (`…:<path>`). Passing it as `remote` (as this once did) made every
 * on-demand size return the whole account's usage instead of the folder's.
 */
export async function folderSize(account: Account, path: string): Promise<SizeResult> {
  const res = await new RcClient().call<{ bytes?: number; count?: number }>("operations/size", {
    fs: `${buildFs(account)}${path}`,
  });
  return { bytes: res?.bytes ?? 0, count: res?.count ?? 0 };
}

/** List a folder (path "" = root), sorted dirs-first then alphabetical. */
export async function listFolder(account: Account, path: string): Promise<RcItem[]> {
  const res = await new RcClient().call<{ list?: RcItem[] }>("operations/list", {
    fs: buildFs(account),
    remote: path,
  });
  let list = res?.list ?? [];

  // Google Drive shortcuts arrive unresolved over shared_with_me (mimeType
  // `…shortcut`, IsDir=false) → un-openable "files". Resolve each to its target
  // via the Drive API and rewrite the row so a folder-shortcut opens its real
  // folder and a file-shortcut downloads its real file (both by target id/path).
  if (account.provider === "drive") {
    const shortcuts = list.filter((i) => i.MimeType === SHORTCUT_MIME && i.ID);
    if (shortcuts.length > 0) {
      const resolved = new Map<string, RcItem>();
      await Promise.all(
        shortcuts.map(async (item) => {
          try {
            const t = await resolveShortcut(account.id, item.ID!);
            resolved.set(item.ID!, t.isDir
              ? { ...item, IsDir: true, ID: t.targetId, Path: t.targetPath || item.Path, MimeType: t.targetMime }
              : { ...item, ID: t.targetId, MimeType: t.targetMime });
          } catch {
            /* leave the shortcut as-is if resolution fails */
          }
        }),
      );
      list = list.map((i) => (i.ID && resolved.has(i.ID) ? resolved.get(i.ID)! : i));
    }
  }

  return [...list].sort((a, b) => {
    if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
    return a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
  });
}

/** Create a new folder named `name` inside `parentPath` ("" = account root). */
export async function createFolder(account: Account, parentPath: string, name: string): Promise<void> {
  const remote = parentPath ? `${parentPath}/${name}` : name;
  await new RcClient().call("operations/mkdir", { fs: buildFs(account), remote });
}
