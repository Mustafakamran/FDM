import { useEffect, useMemo } from "react";
import { Download, Eye, Loader2, AlertCircle, FileSearch, Folder } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "../store/app";
import { useSearch } from "../store/search";
import { useGlobalSearch, type GlobalHit } from "../store/global-search";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { ProviderIcon } from "./icons";
import { EmptyState, Skeleton } from "./ui";
import { fileType } from "../lib/file-types";
import { isPreviewable, extOf } from "../lib/review";
import { formatBytes } from "../lib/format";
import { FOLDER_KEY } from "../lib/ingest";
import { loadRaw } from "../lib/persisted";
import { driveFolderPath, type Account, type DownloadItem, type Provider } from "../lib/tauri/commands";

/** One search hit, tagged with its drive. */
function HitRow({
  hit,
  account,
  label,
  onOpenFolder,
  onReview,
  onDownload,
}: {
  hit: GlobalHit;
  account: Account | undefined;
  label: string;
  onOpenFolder: (h: GlobalHit) => void;
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

  const openName = () => (hit.IsDir ? onOpenFolder(hit) : previewable ? onReview(hit) : undefined);

  return (
    <div className="group flex items-center gap-3 rounded-[9px] px-3 py-2 hover:bg-[var(--hover)]">
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
            onClick={() => onReview(hit)}
            data-tip="Open in review"
            aria-label={`Review ${hit.Name}`}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--faint)] opacity-0 hover:bg-[var(--soft)] hover:text-[var(--acc)] group-hover:opacity-100"
          >
            <Eye size={14} />
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
  const run = useGlobalSearch((s) => s.run);
  const results = useGlobalSearch((s) => s.results);
  const loading = useGlobalSearch((s) => s.loading);
  const error = useGlobalSearch((s) => s.error);

  const accounts = useApp((s) => s.accounts);
  const setView = useApp((s) => s.setView);
  const openReview = useApp((s) => s.openReview);
  const enqueue = useTransfers((s) => s.enqueue);
  const toast = useToasts((s) => s.push);
  const meta = useAccountMeta((s) => s.byId);

  useEffect(() => {
    run(q);
  }, [q, run]);

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

  // Group hits by drive so results read as "from all your drives", then sort
  // each group folders-first, then by name (stable, case-insensitive).
  const groups = useMemo(() => {
    const by = new Map<string, GlobalHit[]>();
    for (const h of results) {
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
  }, [results]);

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

  const openFolder = async (h: GlobalHit) => {
    if (!h.AccountId) return;
    let path = h.Path;
    try {
      path = await resolvePath(h);
    } catch {
      toast(`Couldn’t locate “${h.Name}” on the drive`, "error");
      return;
    }
    useSearch.getState().set("");
    setView({ kind: "browse", accountId: h.AccountId, section: "all", path });
  };
  const review = (h: GlobalHit) => {
    if (!h.AccountId) return;
    // Clear the query FIRST — AppShell renders this overlay whenever the search
    // query is non-empty, so without this the review view opens invisibly
    // beneath it and "Open in review" appears to do nothing (openFolder does the
    // same). Then navigate to the player. Files are id-addressed, so the bare
    // Path is fine here.
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-6 py-4 text-[15px]">
        <FileSearch size={18} className="text-[var(--acc)]" />
        <span className="text-[var(--text-2)]">
          Search across all drives for “<span className="font-medium text-[var(--ink)]">{q}</span>”
        </span>
        {loading && <Loader2 size={15} className="animate-spin text-[var(--faint)]" />}
        {!loading && results.length > 0 && (
          <span className="ml-auto text-[12.5px] text-[var(--faint)]">
            {results.length} result{results.length === 1 ? "" : "s"} · {groups.length} drive{groups.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
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
            <AlertCircle size={18} className="text-[var(--err)]" /> Couldn’t search your drives. Check the connection and try again.
          </div>
        ) : results.length === 0 ? (
          <EmptyState icon={<FileSearch size={20} />} title="No matches" body={`Nothing across your drives matches “${q}”. Try a different search.`} />
        ) : (
          groups.map(([id, hits]) => (
            <div key={id || "unknown"} className="mb-4">
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--surface)] px-3 py-1.5 text-[12px] font-semibold text-[var(--mut)]">
                <ProviderIcon provider={(acctById.get(id)?.provider ?? hits[0]?.Provider ?? "drive") as Provider} size={13} />
                <span className="truncate">{labelFor(id)}</span>
                <span className="text-[var(--faint)]">· {hits.length}</span>
              </div>
              {hits.map((h) => (
                <HitRow
                  key={`${id}:${h.ID || h.Path}:${h.Name}`}
                  hit={h}
                  account={acctById.get(id)}
                  label={labelFor(id)}
                  onOpenFolder={openFolder}
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
