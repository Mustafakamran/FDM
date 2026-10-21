import { useState } from "react";
import { Link as LinkIcon, Plus, ChevronRight, Trash2, FolderOpen } from "lucide-react";
import { useApp } from "../store/app";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { ProviderIcon, providerName } from "./icons";
import { EmptyState } from "./ui";
import { AddLinkDialog } from "./AddLinkDialog";

/** True for a pasted share-link account (a Drive folder link or a Dropbox link). */
function isLinkAccount(id: string): boolean {
  return id.startsWith("drivelink_") || id.startsWith("dropboxlink_");
}

/**
 * "Shared Links" - every folder share-link the user has pasted in (drivelink_ /
 * dropboxlink_). These piggyback a real account's login and are kept out of the
 * ACCOUNTS list + storage counts, so this screen is where you see how many you've
 * loaded, open them, add more, or remove them.
 */
export function LinksView() {
  const accounts = useApp((s) => s.accounts);
  const selectAccount = useApp((s) => s.selectAccount);
  const removeAccount = useApp((s) => s.removeAccount);
  const meta = useAccountMeta((s) => s.byId);
  const [addOpen, setAddOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const links = accounts.filter((a) => isLinkAccount(a.id));

  return (
    <div className="h-full overflow-auto px-8 py-7">
      <div className="mb-7 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
            <LinkIcon size={22} className="text-[var(--acc)]" /> Shared Links
          </h1>
          <p className="mt-1 text-[13.5px] text-[var(--mut)]">
            {links.length > 0 ? (
              <>
                <span className="font-semibold text-[var(--ink)]">{links.length}</span> link{links.length === 1 ? "" : "s"} loaded. Folder share-links you pasted in, opened with a connected account's login.
              </>
            ) : (
              "Paste a Google Drive or Dropbox folder share-link to browse and download it without adding a whole account."
            )}
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-[9px] border border-[var(--acc)] bg-[var(--acc)] px-3.5 py-2 text-[12.5px] font-semibold text-[var(--onacc)] hover:opacity-90"
        >
          <Plus size={14} /> Add link
        </button>
      </div>

      {links.length === 0 ? (
        <EmptyState
          icon={<LinkIcon size={20} />}
          title="No shared links yet"
          body="Click Add link and paste a Drive or Dropbox folder share-link. It appears here so you can reopen, re-download, or remove it any time."
        />
      ) : (
        <div className="overflow-hidden rounded-[13px] border border-[var(--line)] bg-[var(--card)]">
          {links.map((a, i) => (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              onClick={() => selectAccount(a.id)}
              className={`group flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--hover)] ${i > 0 ? "border-t border-[var(--line)]" : ""}`}
            >
              <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-[var(--accw)]">
                <FolderOpen size={18} className="text-[var(--acc)]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-[var(--ink)]">{accountLabel(meta[a.id]?.label, a)}</span>
                <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--faint)]">
                  <ProviderIcon provider={a.provider} size={11} /> {providerName(a.provider)} link
                </span>
              </span>
              {confirm === a.id ? (
                <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => { void removeAccount(a.id); setConfirm(null); }} className="rounded-[7px] bg-[var(--errw)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--err)] hover:opacity-90">Remove</button>
                  <button onClick={() => setConfirm(null)} className="rounded-[7px] px-2 py-1 text-[11.5px] font-medium text-[var(--faint)] hover:text-[var(--ink)]">Cancel</button>
                </span>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirm(a.id); }}
                  data-tip="Remove link"
                  aria-label={`Remove ${accountLabel(meta[a.id]?.label, a)}`}
                  className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] text-[var(--faint)] opacity-0 transition hover:bg-[var(--soft)] hover:text-[var(--err)] group-hover:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              )}
              <ChevronRight size={16} className="shrink-0 text-[var(--faint)] opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          ))}
        </div>
      )}

      {addOpen && <AddLinkDialog onClose={() => setAddOpen(false)} />}
    </div>
  );
}
