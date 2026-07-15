import { useEffect, useState } from "react";
import { FolderTree, Folder, FolderSymlink, ChevronRight, Download, Loader2, ExternalLink } from "lucide-react";
import { useApp } from "../store/app";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { useBrowse, browseKey } from "../store/browse";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { pickDownloadDest } from "../lib/ingest";
import { openShortcutFolder, downloadShortcutFolder } from "../lib/drive-link";
import { formatBytes } from "../lib/format";
import { fileType } from "../lib/file-types";
import { ProviderIcon } from "./icons";
import { EmptyState } from "./ui";
import type { Account } from "../lib/tauri/commands";
import type { RcItem } from "../lib/rc/browse";

/**
 * "Shared Folders" — a folder tree of every "Shared with me" folder, grouped per
 * Google Drive, so client footage is browsable/downloadable in one place instead
 * of only under each drive. Direct shared folders expand inline (lazy-listed);
 * shortcut folders open by id via the linked-folder engine (their target can't be
 * reached by name-path — see drive-link.ts).
 */
export function SharedFoldersView() {
  const accounts = useApp((s) => s.accounts);
  const meta = useAccountMeta((s) => s.byId);
  // shared_with_me is Drive-only; exclude linked-folder accounts (single rooted
  // folders, not a shared collection).
  const drives = accounts.filter((a) => a.provider === "drive" && !a.id.startsWith("drivelink_"));

  return (
    <div className="h-full overflow-auto px-8 py-7">
      <div className="mb-7">
        <h1 className="flex items-center gap-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
          <FolderTree size={22} className="text-[var(--acc)]" /> Shared Folders
        </h1>
        <p className="mt-1 text-[13.5px] text-[var(--mut)]">
          Every folder shared with you, grouped by drive. Expand to browse; download any folder or file straight from here.
        </p>
      </div>

      {drives.length === 0 ? (
        <EmptyState
          icon={<FolderTree size={20} />}
          title="No Google Drive connected"
          body="Connect a Google Drive account to see the folders clients have shared with you here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {drives.map((account) => (
            <DriveGroup key={account.id} account={account} label={accountLabel(meta[account.id]?.label, account)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One drive's shared-with-me root, as an expandable tree. */
function DriveGroup({ account, label }: { account: Account; label: string }) {
  const k = browseKey(account.id, "");
  const children = useBrowse((s) => s.listings[k]);
  const loading = useBrowse((s) => s.loading[k]);

  useEffect(() => {
    void useBrowse.getState().ensure(account, "");
  }, [account]);

  const folders = (children ?? []).filter((c) => c.IsDir);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-[var(--mut)]">
        <ProviderIcon provider={account.provider} size={13} />
        <span className="truncate">{label}</span>
        {children && <span className="tnum text-[var(--faint)]">· {folders.length}</span>}
      </div>
      <div className="overflow-hidden rounded-[13px] border border-[var(--line)] bg-[var(--card)]">
        {children === undefined || loading ? (
          <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-[var(--faint)]">
            <Loader2 size={14} className="animate-spin" /> Loading shared folders…
          </div>
        ) : folders.length === 0 ? (
          <div className="px-4 py-3 text-[12.5px] text-[var(--faint)]">No folders shared with this drive.</div>
        ) : (
          folders.map((f, i) => <TreeNode key={f.LinkFolderId ?? f.Path} account={account} item={f} depth={0} first={i === 0} />)
        )}
      </div>
    </div>
  );
}

/** A folder row in the tree. Direct folders expand inline; shortcut folders
 *  (LinkFolderId) open by id in the browse view. */
function TreeNode({ account, item, depth, first }: { account: Account; item: RcItem; depth: number; first: boolean }) {
  const [open, setOpen] = useState(false);
  const isLink = !!item.LinkFolderId;
  const k = browseKey(account.id, item.Path);
  const children = useBrowse((s) => (isLink ? undefined : s.listings[k]));
  const loading = useBrowse((s) => (isLink ? false : s.loading[k]));
  const setView = useApp((s) => s.setView);

  const toggle = () => {
    if (isLink) { void openShortcutFolder(account.id, item.Name, item.LinkFolderId!); return; }
    if (!open && children === undefined) void useBrowse.getState().ensure(account, item.Path);
    setOpen((o) => !o);
  };
  const openInBrowse = () => {
    if (isLink) void openShortcutFolder(account.id, item.Name, item.LinkFolderId!);
    else setView({ kind: "browse", accountId: account.id, section: "all", path: item.Path });
  };
  const download = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const dest = await pickDownloadDest();
    if (!dest) return;
    if (isLink) {
      void downloadShortcutFolder(account.id, item.Name, item.LinkFolderId!, dest);
    } else {
      enqueueItem(account.id, { path: item.Path, name: item.Name, isDir: true, size: item.Size > 0 ? item.Size : 0, id: item.ID ?? "" }, dest);
    }
  };

  const folders = (children ?? []).filter((c) => c.IsDir);
  const files = (children ?? []).filter((c) => !c.IsDir);
  const pad = 16 + depth * 18;

  return (
    <div>
      <div
        className={`group flex items-center gap-2 py-2.5 pr-3 transition-colors hover:bg-[var(--soft)] ${first && depth === 0 ? "" : "border-t border-[var(--line)]"}`}
        style={{ paddingLeft: pad }}
      >
        <button onClick={toggle} aria-label={open ? "Collapse" : "Expand"} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[var(--faint)] hover:bg-[var(--line)] hover:text-[var(--ink)]">
          {isLink ? <ExternalLink size={13} /> : <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />}
        </button>
        <button onClick={openInBrowse} className="flex min-w-0 flex-1 items-center gap-2 text-left" data-tip={isLink ? "Open shared folder" : item.Name}>
          {isLink ? <FolderSymlink size={16} className="shrink-0 text-[var(--acc)]" /> : <Folder size={16} className="shrink-0 text-[var(--acc)]" />}
          <span className="truncate text-[13px] font-medium text-[var(--ink)]">{item.Name}</span>
        </button>
        <button onClick={download} data-tip="Download folder" aria-label={`Download ${item.Name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--line)] hover:text-[var(--ink)] group-hover:opacity-100">
          <Download size={14} />
        </button>
      </div>

      {open && !isLink && (
        loading && children === undefined ? (
          <div className="flex items-center gap-2 py-2 text-[12px] text-[var(--faint)]" style={{ paddingLeft: pad + 22 }}>
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : children && folders.length === 0 && files.length === 0 ? (
          <div className="py-2 text-[12px] text-[var(--faint)]" style={{ paddingLeft: pad + 22 }}>Empty folder</div>
        ) : (
          <>
            {folders.map((c) => <TreeNode key={c.LinkFolderId ?? c.Path} account={account} item={c} depth={depth + 1} first={false} />)}
            {files.map((f) => <FileLeaf key={f.Path} account={account} item={f} depth={depth + 1} />)}
          </>
        )
      )}
    </div>
  );
}

/** A file row (leaf) in the tree — download only. */
function FileLeaf({ account, item, depth }: { account: Account; item: RcItem; depth: number }) {
  const ft = fileType(item.Name, false);
  const download = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const dest = await pickDownloadDest();
    if (!dest) return;
    enqueueItem(account.id, { path: item.Path, name: item.Name, isDir: false, size: item.Size > 0 ? item.Size : 0, id: item.ID ?? "" }, dest);
  };
  return (
    <div className="group flex items-center gap-2 border-t border-[var(--line)] py-2 pr-3 hover:bg-[var(--soft)]" style={{ paddingLeft: 16 + depth * 18 + 22 }}>
      <ft.Icon size={15} style={{ color: ft.color }} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--ink)]" data-tip={item.Name}>{item.Name}</span>
      {item.Size > 0 && <span className="tnum shrink-0 text-[11.5px] text-[var(--faint)]">{formatBytes(item.Size)}</span>}
      <button onClick={download} data-tip="Download" aria-label={`Download ${item.Name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--line)] hover:text-[var(--ink)] group-hover:opacity-100">
        <Download size={13} />
      </button>
    </div>
  );
}

// Enqueue a single Drive item (folder or file) into the download queue.
function enqueueItem(accountId: string, item: { path: string; name: string; isDir: boolean; size: number; id: string }, dest: string) {
  useTransfers.getState().enqueue(accountId, [item], dest);
  useToasts.getState().push(`Queued ${item.name}`, "success");
}
