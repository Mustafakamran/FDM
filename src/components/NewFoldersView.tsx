import { FolderPlus, Folder, Loader2, ChevronRight } from "lucide-react";
import { useApp } from "../store/app";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { useNewFolders } from "../lib/use-new-folders";
import { NEW_FOLDER_WINDOW_DAYS } from "../store/new-folders";
import { formatBytes, formatDate } from "../lib/format";
import { ProviderIcon } from "./icons";
import { EmptyState } from "./ui";
import type { SizeValue } from "../store/browse";

/**
 * "New folders" — top-level folders a client has added to any connected drive
 * since it was last seen (within the recent window), that you haven't downloaded
 * yet. Clicking a folder jumps to its location in the normal browse view.
 */
export function NewFoldersView() {
  const setView = useApp((s) => s.setView);
  const meta = useAccountMeta((s) => s.byId);
  const { groups, count, totalSize, allSized, sizeOf } = useNewFolders();

  return (
    <div className="h-full overflow-auto px-8 py-7">
      <div className="mb-7">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">New folders</div>
        <h1 className="mt-1 flex items-center gap-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
          <FolderPlus size={22} className="text-[var(--acc)]" /> Recently added
        </h1>
        <p className="mt-1 text-[13.5px] text-[var(--mut)]">
          {count > 0 ? (
            <>
              <span className="font-semibold text-[var(--ink)]">{count}</span> new folder{count === 1 ? "" : "s"} across your drives ·{" "}
              <span className="tnum">{formatBytes(totalSize)}</span>
              {!allSized && <span className="text-[var(--faint)]"> +</span>} total
            </>
          ) : (
            `Top-level folders added in the last ${NEW_FOLDER_WINDOW_DAYS} days show up here.`
          )}
        </p>
      </div>

      {count === 0 ? (
        <EmptyState
          icon={<FolderPlus size={20} />}
          title="Nothing new right now"
          body={`When a client adds a folder to one of your drives, it appears here so you know what still needs downloading. Only folders from the last ${NEW_FOLDER_WINDOW_DAYS} days that you haven't downloaded yet are shown.`}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <div key={g.account.id}>
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-[var(--mut)]">
                <ProviderIcon provider={g.account.provider} size={13} />
                <span className="truncate">{accountLabel(meta[g.account.id]?.label, g.account)}</span>
                <span className="tnum text-[var(--faint)]">· {g.folders.length}</span>
              </div>
              <div className="overflow-hidden rounded-[13px] border border-[var(--line)]">
                {g.folders.map((f, i) => (
                  <button
                    key={f.Path}
                    onClick={() => setView({ kind: "browse", accountId: g.account.id, section: "all", path: f.Path })}
                    className={`group flex w-full items-center gap-3 bg-[var(--card)] px-4 py-3 text-left hover:bg-[var(--hover)] ${i > 0 ? "border-t border-[var(--line)]" : ""}`}
                  >
                    <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-[var(--accw)]">
                      <Folder size={18} className="text-[var(--acc)]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-[var(--ink)]">{f.Name}</span>
                      <span className="block truncate text-[11.5px] text-[var(--faint)]">Added {formatDate(f.ModTime)}</span>
                    </span>
                    <SizeLabel size={sizeOf(g.account.id, f.Path)} />
                    <ChevronRight size={16} className="shrink-0 text-[var(--faint)] opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SizeLabel({ size }: { size: SizeValue | undefined }) {
  if (typeof size === "number") return <span className="tnum shrink-0 text-[12.5px] text-[var(--text-2)]">{formatBytes(size)}</span>;
  if (size === "error") return <span className="shrink-0 text-[12px] text-[var(--faint)]">size n/a</span>;
  return <Loader2 size={14} className="shrink-0 animate-spin text-[var(--faint)]" />;
}
