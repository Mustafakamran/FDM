import { useMemo } from "react";
import { Download, Eye, Play, Loader2, AlertCircle, FileSearch, Folder, FolderOpen, FolderSearch, HardDrive, Globe } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "../store/app";
import { useSearch, type SearchScope } from "../store/search";
import { type GlobalHit } from "../store/global-search";
import { usePreview } from "../store/preview";
import { useHighlight } from "../store/highlight";
import { useIndex } from "../store/index-store";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { ProviderIcon } from "./icons";
import { EmptyState, Skeleton } from "./ui";
import { fileType } from "../lib/file-types";
import { isPreviewable, isVideo, extOf } from "../lib/review";
import { formatBytes } from "../lib/format";
import { FOLDER_KEY } from "../lib/ingest";
import { loadRaw } from "../lib/persisted";
import { useScopedSearch } from "../lib/use-scoped-search";
import { useCommands, filterCommands } from "../lib/use-commands";
import { driveFolderPath, type Account, type DownloadItem, type Provider } from "../lib/tauri/commands";

/** One search hit, tagged with its drive. */
function HitRow({
  hit,
  account,
  label,
  onOpenLocation,
  onPreview,
  onReview,
  onDownload,
}: {
  hit: GlobalHit;
  account: Account | undefined;
  label: string;
  onOpenLocation: (h: GlobalHit) => void;
  onPreview: (h: GlobalHit) => void;
  onReview: (h: GlobalHit) => void;
  onDownload: (h: GlobalHit) => void;
}) {
  const ft = fileType(hit.Name, hit.IsDir);
  const ext = extOf(hit.Name).replace(/^\./, "").slice(0, 4).toUpperCase();
  const previewable = !hit.IsDir && isPreviewable(hit.Name);
  const provider = (account?.provider ?? hit.Provider ?? "drive") as Provider;

  const tile = hit.IsDir ? (
    <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--accw)]">
      <Folder size={17} className="text-[var(--acc)]" />
    </span>
  ) : (
    <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] font-mono text-[9px] font-semibold" style={{ background: "var(--accw)", color: ft.color }}>
      {ext || "FILE"}
    </span>
  );

  const isVid = !hit.IsDir && isVideo(hit.Name);
  // Clicking a hit's name takes you to WHERE it lives (open the folder, or jump
  // to a file's containing folder) — preview/review are the explicit icon actions.
  const openName = () => onOpenLocation(hit);

  return (
    <div className="group flex animate-item items-center gap-3 rounded-[9px] px-3 py-2 transition-colors hover:bg-[var(--hover)]">
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={openName}>
        {tile}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-[var(--ink)]">{hit.Name}</span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--faint)]">
            <ProviderIcon provider={provider} size={11} />
            <span className="truncate">{label}</span>
            {!hit.IsDir && hit.Size > 0 && <span>· {formatBytes(hit.Size)}</span>}
            {hit.IsDir && <span>· Folder</span>}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        {previewable && (
          <button
            onClick={() => onPreview(hit)}
            data-tip="Preview"
            aria-label={`Preview ${hit.Name}`}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--faint)] opacity-0 hover:bg-[var(--soft)] hover:text-[var(--acc)] group-hover:opacity-100"
          >
            <Eye size={14} />
          </button>
        )}
        {isVid && (
          <button
            onClick={() => onReview(hit)}
            data-tip="Review"
            aria-label={`Review ${hit.Name}`}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--faint)] opacity-0 hover:bg-[var(--soft)] hover:text-[var(--acc)] group-hover:opacity-100"
          >
            <Play size={14} />
          </button>
        )}
        <button
          onClick={() => onDownload(hit)}
          data-tip="Download"
          aria-label={`Download ${hit.Name}`}
          className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--faint)] opacity-0 hover:bg-[var(--soft)] hover:text-[var(--dl)] group-hover:opacity-100"
        >
          <Download size={14} />
        </button>
      </div>
    </div>
  );
}

/** Results of a search across ALL connected drives at once. Shown (in place of
 *  the normal view) whenever the top-bar search box has a query. Each hit shows
 *  which drive it lives on and opens/downloads against that drive directly. */
export function GlobalSearchResults() {
  const q = useSearch((s) => s.q);
  const setScope = useSearch((s) => s.setScope);
  const { scope, available, hits, loading, error, folderPath, folderRecursive, account: scopeAccount } = useScopedSearch();

  const accounts = useApp((s) => s.accounts);
  const setView = useApp((s) => s.setView);
  const openReview = useApp((s) => s.openReview);
  const enqueue = useTransfers((s) => s.enqueue);
  const toast = useToasts((s) => s.push);
  const meta = useAccountMeta((s) => s.byId);

  // Commands (nav/actions) that match the query — files AND commands live in the
  // same results now, so the search box is the command palette.
  const commands = filterCommands(useCommands(), q);

  const acctById = useMemo(() => {
    const m = new Map<string, Account>();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);
  const labelFor = (id: string | undefined) => {
    if (!id) return "Unknown drive";
    const a = acctById.get(id);
    return a ? accountLabel(meta[id]?.label, a) : id;
  };
  const results = hits;

  // Group hits by drive, then sort each group folders-first, then by name.
  const groups = useMemo(() => {
    const by = new Map<string, GlobalHit[]>();
    for (const h of hits) {
      const id = h.AccountId ?? "";
      const arr = by.get(id) ?? [];
      arr.push(h);
      by.set(id, arr);
    }
    for (const arr of by.values()) {
      arr.sort((a, b) => {
        if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
        return a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
      });
    }
    return [...by.entries()];
  }, [hits]);

  // Drive live-search returns no path (only id + bare name), so a Drive FOLDER
  // hit's `Path` is just its name and can't be navigated/recursed directly.
  // Resolve the real rclone path from the id before using it. Dropbox hits carry
  // a real path_display, and Drive FILES are id-addressed (review/download key
  // off the id), so only Drive folders need this round-trip.
  const resolvePath = async (h: GlobalHit): Promise<string> => {
    const provider = acctById.get(h.AccountId!)?.provider ?? h.Provider;
    if (provider === "drive" && h.IsDir && h.ID) {
      return await driveFolderPath(h.AccountId!, h.ID);
    }
    return h.Path;
  };

  // Go to WHERE a hit lives: open a folder hit; for a file hit, navigate to its
  // containing folder (its real path resolved from the id for Drive, whose search
  // returns only the bare name).
  const openLocation = async (h: GlobalHit) => {
    if (!h.AccountId) return;
    let full = h.Path;
    try {
      const provider = acctById.get(h.AccountId)?.provider ?? h.Provider;
      // driveFolderPath walks parents from any id (file or folder), so it yields
      // the item's full account-relative path either way.
      if (provider === "drive" && h.ID) full = await driveFolderPath(h.AccountId, h.ID);
    } catch {
      toast(`Couldn’t locate “${h.Name}” on the drive`, "error");
      return;
    }
    // Folder → open it; file → open the folder that contains it.
    const target = h.IsDir ? full : full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
    // Flag the item so the browse view flashes + selects it once it lands there,
    // so you can see exactly which file the search meant.
    useHighlight.getState().set(h.AccountId, full);
    useSearch.getState().set("");
    setView({ kind: "browse", accountId: h.AccountId, section: "all", path: target });
  };
  // Preview is a modal overlay that sits ON TOP of the search results, so unlike
  // review/openFolder it must NOT clear the query — closing the preview returns
  // the user to their results. Files are id-addressed, so the bare Path is fine.
  const preview = (h: GlobalHit) => {
    if (!h.AccountId) return;
    usePreview.getState().open(h.AccountId, { path: h.Path, name: h.Name, fileId: h.ID ?? "", size: h.Size > 0 ? h.Size : 0, ext: extOf(h.Name) });
  };
  const review = (h: GlobalHit) => {
    if (!h.AccountId) return;
    // Clear the query FIRST — AppShell renders this overlay whenever the search
    // query is non-empty, so without this the review view opens invisibly
    // beneath it and Review appears to do nothing (openFolder does the same).
    // Then navigate to the player. Files are id-addressed, so the bare Path is fine.
    useSearch.getState().set("");
    openReview(h.AccountId, { path: h.Path, name: h.Name, fileId: h.ID ?? "", size: h.Size > 0 ? h.Size : 0, ext: extOf(h.Name) });
  };
  const download = async (h: GlobalHit) => {
    if (!h.AccountId) return;
    let path = h.Path;
    try {
      path = await resolvePath(h);
    } catch {
      toast(`Couldn’t locate “${h.Name}” on the drive`, "error");
      return;
    }
    let dest = loadRaw(FOLDER_KEY, "");
    if (!dest) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      dest = picked;
    }
    const item: DownloadItem = { path, name: h.Name, isDir: h.IsDir, size: h.Size > 0 ? h.Size : 0, id: h.ID ?? "" };
    enqueue(h.AccountId, [item], dest);
    toast(`Queued ${h.Name}`, "success");
  };

  const folderName = folderPath ? folderPath.split("/").pop() : "";
  const scopeLabel =
    scope === "folder" ? `in ${folderName || "this folder"}` : scope === "drive" ? `in ${labelFor(scopeAccount?.id)}` : "across all drives";
  const runCommand = (c: { run: () => void }) => {
    c.run();
    useSearch.getState().set(""); // a nav command dismisses the search overlay
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 py-4 text-[15px]">
        <FileSearch size={18} className="text-[var(--acc)]" />
        <span className="text-[var(--text-2)]">
          Search {scopeLabel} for “<span className="font-medium text-[var(--ink)]">{q}</span>”
        </span>
        {loading && <Loader2 size={15} className="animate-spin text-[var(--faint)]" />}

        {/* Scope chips — pick where to look. Only the scopes that make sense in
            the current context are shown; "All drives" is always available. */}
        <div className="ml-auto flex items-center gap-1.5">
          {available.map((s) => {
            const on = s === scope;
            const meta_ = SCOPE_META[s];
            return (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold ${
                  on ? "border-[var(--acc)] bg-[var(--acc)] text-[var(--onacc)]" : "border-[var(--line)] text-[var(--mut)] hover:border-[var(--line2)]"
                }`}
              >
                <meta_.Icon size={12} /> {meta_.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {/* Commands (nav/actions) matching the query, above file results. */}
        {commands.length > 0 && (
          <div className="mb-4">
            <div className="px-3 py-1.5 text-[12px] font-semibold text-[var(--mut)]">Commands</div>
            {commands.map((c) => (
              <button
                key={c.id}
                onClick={() => runCommand(c)}
                className="flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left text-sm text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                <span className="shrink-0 text-[var(--text-3)]">{c.icon}</span>
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <span className="shrink-0 text-xs text-[var(--text-3)]">{c.hint}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Folder scope on a non-indexed drive only sees the folder's direct
            contents — offer to index for a full-subtree search. */}
        {scope === "folder" && !folderRecursive && scopeAccount && folderPath && (
          <button
            onClick={() => void useIndex.getState().indexFolder(scopeAccount, folderPath)}
            className="mb-3 flex w-full items-center gap-2 rounded-[9px] border border-dashed border-[var(--line2)] px-3 py-2 text-left text-[12.5px] text-[var(--faint)] hover:text-[var(--text-2)]"
          >
            <FolderSearch size={14} /> Searching this folder’s contents only — index it to search every subfolder too.
          </button>
        )}

        {loading && results.length === 0 ? (
          <div className="px-2 py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-2.5">
                <Skeleton className="h-[34px] w-[34px] shrink-0 rounded-[10px]" />
                <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 13) % 45)}%` }} />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-[var(--mut)]">
            <AlertCircle size={18} className="text-[var(--err)]" /> Couldn’t search. Check the connection and try again.
          </div>
        ) : results.length === 0 ? (
          commands.length === 0 && (
            <EmptyState icon={<FileSearch size={20} />} title="No matches" body={`Nothing ${scopeLabel} matches “${q}”. Try a different search or scope.`} />
          )
        ) : (
          groups.map(([id, groupHits]) => (
            <div key={id || "unknown"} className="mb-4">
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--surface)] px-3 py-1.5 text-[12px] font-semibold text-[var(--mut)]">
                <ProviderIcon provider={(acctById.get(id)?.provider ?? groupHits[0]?.Provider ?? "drive") as Provider} size={13} />
                <span className="truncate">{labelFor(id)}</span>
                <span className="text-[var(--faint)]">· {groupHits.length}</span>
              </div>
              {groupHits.map((h) => (
                <HitRow
                  key={`${id}:${h.ID || h.Path}:${h.Name}`}
                  hit={h}
                  account={acctById.get(id)}
                  label={labelFor(id)}
                  onOpenLocation={openLocation}
                  onPreview={preview}
                  onReview={review}
                  onDownload={download}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const SCOPE_META: Record<SearchScope, { label: string; Icon: typeof FolderOpen }> = {
  folder: { label: "This folder", Icon: FolderOpen },
  drive: { label: "This drive", Icon: HardDrive },
  all: { label: "All drives", Icon: Globe },
};
