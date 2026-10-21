import { RcClient } from "./client";
import { resolveShortcut, driveList, type Account } from "../tauri/commands";

/** Google Drive shortcut mime type - rclone surfaces these unresolved. */
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
  /**
   * Target folder id for a Google Drive folder-SHORTCUT. Set by
   * resolveDriveShortcuts. Such a folder can't be reached by name-path (its
   * target lives outside the shared_with_me namespace and folder names may
   * contain `/`), so open/download route through an id-rooted linked folder
   * (get_or_create_drive_link) instead of navigating by Path.
   */
  LinkFolderId?: string;
  /**
   * First-parent folder id, set only for rows in the Drive "Shared with me" top
   * (which has no folder id of its own). Lets a file download there root a
   * drivelink at its real parent. Empty/undefined elsewhere.
   */
  ParentId?: string;
}

/** Virtual root-folder ids for a plain Drive account (mirror Drive web's nav). */
export const DRIVE_MY = "root";
export const DRIVE_SHARED = "__shared__";
/** Human labels for the virtual Drive roots (for breadcrumbs / titles). */
export const DRIVE_ROOT_LABELS: Record<string, string> = {
  [DRIVE_MY]: "My Drive",
  [DRIVE_SHARED]: "Shared with me",
};

/**
 * rclone connection string for an account. Google Drive must surface
 * "Shared with me" (where clients drop footage), so we append the
 * shared_with_me connection parameter. Dropbox uses the plain remote.
 */
export function buildFs(account: Account): string {
  // Drive links (folder id) and Shared-Drive links (team_drive) are rooted by
  // their config - list plainly, not "Shared with me".
  if (account.id.startsWith("drivelink_") || account.id.startsWith("teamdrive_")) return `${account.id}:`;
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
 * `remote` subpath - so the folder path MUST be folded into the fs connection
 * string (`…:<path>`). Passing it as `remote` (as this once did) made every
 * on-demand size return the whole account's usage instead of the folder's.
 */
export async function folderSize(account: Account, path: string): Promise<SizeResult> {
  // Plain Drive browses by id-chain (not an rclone name-path), so on-demand
  // folder sizing via rclone doesn't apply - skip it (avoids a doomed name-path
  // call per visible row, which also drove re-render churn while scrolling).
  if (isPlainDrive(account)) return { bytes: 0, count: 0 };
  const res = await new RcClient().call<{ bytes?: number; count?: number }>("operations/size", {
    fs: `${buildFs(account)}${path}`,
  });
  return { bytes: res?.bytes ?? 0, count: res?.count ?? 0 };
}

/**
 * Rewrite Google Drive shortcut rows to their targets. Shortcuts arrive
 * unresolved (mimeType `…shortcut`, IsDir=false) → un-openable "FILE" rows; a
 * folder-shortcut becomes its real folder (opens/recurses/downloads by target
 * id+path) and a file-shortcut its real file. `accountIdOf` returns the Drive
 * account id to resolve against for each item, or undefined to skip it (non-Drive
 * items, or hits with no known account). Items that fail to resolve are left as-is.
 */
export async function resolveDriveShortcuts<T extends RcItem>(
  items: T[],
  accountIdOf: (item: T) => string | undefined,
): Promise<T[]> {
  const shortcuts = items.filter((i) => i.MimeType === SHORTCUT_MIME && i.ID && accountIdOf(i));
  if (shortcuts.length === 0) return items;
  const resolved = new Map<string, T>();
  await Promise.all(
    shortcuts.map(async (item) => {
      try {
        const t = await resolveShortcut(accountIdOf(item)!, item.ID!);
        resolved.set(item.ID!, t.isDir
          // Folder target: render as an openable folder but keep the shortcut's
          // own Name/Path - the real target is reached by id (LinkFolderId), not
          // by a name-path that wouldn't resolve over shared_with_me.
          ? { ...item, IsDir: true, MimeType: t.targetMime, LinkFolderId: t.targetId }
          // File target: id-addressed, so pointing at the target id is enough.
          : { ...item, ID: t.targetId, MimeType: t.targetMime });
      } catch {
        /* leave the shortcut as-is if resolution fails */
      }
    }),
  );
  return items.map((i) => (i.ID && resolved.has(i.ID) ? resolved.get(i.ID)! : i));
}

/** Raw `operations/list` against a specific fs connection string. */
async function rawList(fs: string, path: string): Promise<RcItem[]> {
  const res = await new RcClient().call<{ list?: RcItem[] }>("operations/list", { fs, remote: path });
  return res?.list ?? [];
}

/** True for a real Google Drive account (not a drive/team-drive LINK remote). */
export function isPlainDrive(account: Account): boolean {
  return account.provider === "drive" && !account.id.startsWith("drivelink_") && !account.id.startsWith("teamdrive_");
}

/** The two virtual root folders of a plain Drive account (like Drive web). */
const DRIVE_ROOT_ENTRIES: RcItem[] = [
  { Name: "My Drive", Path: DRIVE_MY, Size: 0, IsDir: true, ModTime: "", MimeType: "application/vnd.google-apps.folder", ID: DRIVE_MY, LinkFolderId: DRIVE_MY },
  { Name: "Shared with me", Path: DRIVE_SHARED, Size: 0, IsDir: true, ModTime: "", MimeType: "application/vnd.google-apps.folder", ID: DRIVE_SHARED },
];

/** Last id of a Drive id-chain path ("" = account root). */
export function driveFolderId(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length ? segs[segs.length - 1] : "";
}

/**
 * id -> display-name cache for Drive breadcrumbs. Drive paths are id chains, so
 * crumb labels aren't in the path; we remember each folder's name as its listing
 * loads. Keyed by `${accountId}:${id}`.
 */
const driveNameCache = new Map<string, string>();

/** Human label for one Drive path segment id (virtual roots + cached names). */
export function driveSegmentLabel(accountId: string, id: string): string {
  return DRIVE_ROOT_LABELS[id] ?? driveNameCache.get(`${accountId}:${id}`) ?? "Folder";
}

/**
 * ID-native Drive listing. A plain Drive account browses by FOLDER ID (not
 * rclone name-paths, which dangle on duplicate names + shortcuts over
 * `shared_with_me`). `path` is an id chain ("" = root; "root" = My Drive;
 * "__shared__" = Shared with me; "root/<id>/<id>" = nested). Each row's Path
 * appends its own id so navigation stays id-addressed end to end - exactly how
 * the Drive web file browser works.
 */
async function listDriveById(account: Account, path: string): Promise<RcItem[]> {
  if (path === "") return DRIVE_ROOT_ENTRIES;
  const folderId = driveFolderId(path);
  const rows = await driveList(account.id, folderId);
  // Remember id -> name so breadcrumbs can label id-chain segments.
  for (const r of rows) if (r.isDir) driveNameCache.set(`${account.id}:${r.id}`, r.name);
  const items: RcItem[] = rows.map((r) => ({
    Name: r.name,
    Path: `${path}/${r.id}`,
    Size: r.size,
    IsDir: r.isDir,
    ModTime: r.modTime,
    MimeType: r.mimeType,
    ID: r.id,
    // Every Drive folder opens/downloads by id (never a name-path).
    LinkFolderId: r.isDir ? r.id : undefined,
    ParentId: r.parentId || undefined,
  }));
  return items.sort((a, b) => {
    if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
    return a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
  });
}

/** List a folder (path "" = root), sorted dirs-first then alphabetical. */
export async function listFolder(account: Account, path: string): Promise<RcItem[]> {
  // Plain Drive accounts use the ID-native Drive API browser.
  if (isPlainDrive(account)) return listDriveById(account, path);

  let list = await rawList(buildFs(account), path);

  // Resolve Drive shortcuts so a folder-shortcut opens its real folder instead of
  // showing an un-openable "FILE" (see resolveDriveShortcuts).
  if (account.provider === "drive") {
    list = await resolveDriveShortcuts(list, () => account.id);
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
