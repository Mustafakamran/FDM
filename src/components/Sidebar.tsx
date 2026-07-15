import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, Home, FolderOpen, ArrowDownUp, AlertCircle, Trash2, Loader2, Link as LinkIcon, FolderPlus, FolderTree, MoreHorizontal, Pencil, FolderSearch, ArrowUp, ArrowDown } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "../store/app";
import { useTransfers } from "../store/transfers";
import { useStorage, type Storage } from "../store/storage";
import { useAccountMeta, accountLabel, type Meta } from "../store/account-meta";
import { useIndex, type IndexEntry } from "../store/index-store";
import { useAccountOrder, orderAccounts } from "../store/account-order";
import { ContextMenu, type MenuItem } from "./ui/ContextMenu";
import { ProviderIcon, providerName } from "./icons";
import { Skeleton } from "./ui";
import { AddAccountDialog } from "./AddAccountDialog";
import { AddLinkDialog } from "./AddLinkDialog";
import { formatBytes, formatSpeed } from "../lib/format";
import { useNewFolders } from "../lib/use-new-folders";
import { laneOf } from "../lib/lane";
import type { Account, Provider } from "../lib/tauri/commands";

export function Sidebar() {
  const { view, accounts, accountsLoaded, selectAccount, removeAccount, showTransfers, showNewFolders, showShared, setView } = useApp(
    useShallow((s) => ({
      view: s.view,
      accounts: s.accounts,
      accountsLoaded: s.accountsLoaded,
      selectAccount: s.selectAccount,
      removeAccount: s.removeAccount,
      showTransfers: s.showTransfers,
      showNewFolders: s.showNewFolders,
      showShared: s.showShared,
      setView: s.setView,
    })),
  );
  const onTransfers = view.kind === "transfers";
  const onFiles = view.kind === "browse";
  const onHome = view.kind === "home";
  const onNewFolders = view.kind === "new-folders";
  const onShared = view.kind === "shared";
  const newFolderCount = useNewFolders().count;
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const uploads = useTransfers((s) => s.uploads);
  const activeUploads = uploads.filter((u) => !u.finished && !u.cancelled).length;
  const storage = useStorage((s) => s.byAccount);
  const fetchStorage = useStorage((s) => s.fetch);
  const meta = useAccountMeta((s) => s.byId);
  const indexEntries = useIndex((s) => s.byAccount);
  const emailErrors = useAccountMeta((s) => s.errors);
  const fetchEmail = useAccountMeta((s) => s.fetchEmail);
  const [addProvider, setAddProvider] = useState<Provider | null>(null);
  const [addLink, setAddLink] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    for (const a of accounts) {
      void fetchStorage(a);
      void fetchEmail(a.id);
    }
  }, [accounts, fetchStorage, fetchEmail]);

  const activeAccount = view.kind === "browse" ? view.accountId : null;

  // Recomputed every 1s tick while a download runs (jobs/queue change) — memoize
  // so it doesn't do fresh filter/reduce passes on every keystroke elsewhere in
  // the tree that happens to also touch this component's props.
  const { counts, totalSpeed } = useMemo(() => {
    const active = jobs.filter((j) => !j.finished && !j.cancelled);
    return {
      counts: {
        downloading: active.length + queue.filter((q) => !q.paused).length,
        web:
          active.filter((j) => laneOf(j.accountId) === "secondary").length +
          queue.filter((q) => laneOf(q.accountId) === "secondary" && !q.paused).length,
      },
      totalSpeed: active.reduce((s, j) => s + Math.max(0, j.speed), 0),
    };
  }, [jobs, queue]);

  const goFiles = () => {
    if (activeAccount) return;
    if (accounts[0]) selectAccount(accounts[0].id);
  };

  // Stable callbacks so AccountTile's memoization actually holds across the
  // 1s re-renders this component gets while a download is active (jobs/queue
  // above change every tick, but individual tiles' own data doesn't).
  const toggleConfirmRemove = useCallback((id: string) => setConfirmRemove((c) => (c === id ? null : id)), []);
  const handleRemove = useCallback(
    (id: string) => {
      void removeAccount(id);
      setConfirmRemove(null);
    },
    [removeAccount],
  );

  // User-arranged account order (drag-free: move up/down from the tile menu).
  const accountOrder = useAccountOrder((s) => s.order);
  const orderedAccounts = useMemo(() => orderAccounts(accounts, accountOrder), [accounts, accountOrder]);
  const onMoveAccount = useCallback(
    (id: string, dir: -1 | 1) => useAccountOrder.getState().move(id, dir, orderedAccounts.map((a) => a.id)),
    [orderedAccounts],
  );

  return (
    <aside className="flex w-[236px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)]">
      {/* Primary nav (the brand lives in the top bar now). */}
      <div className="flex flex-col gap-0.5 px-3 pt-4">
        <NavItem icon={<Home size={16} />} label="Home" active={onHome} onClick={() => setView({ kind: "home" })} />
        <NavItem icon={<FolderOpen size={16} />} label="Files" active={onFiles} onClick={goFiles} />
        <NavItem icon={<FolderPlus size={16} />} label="Recent Folders" active={onNewFolders} onClick={showNewFolders} badge={newFolderCount || undefined} />
        <NavItem icon={<FolderTree size={16} />} label="Shared Folders" active={onShared} onClick={showShared} />
        <NavItem icon={<ArrowDownUp size={16} />} label="Transfers" active={onTransfers} onClick={() => showTransfers()} badge={(counts.downloading + activeUploads) || undefined} />
      </div>

      {/* Accounts */}
      <div className="mb-2 mt-3.5 flex items-center justify-between px-[18px]">
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-[var(--faint)]">ACCOUNTS</span>
        <span className="font-mono text-[10.5px] font-semibold text-[var(--faint)]">{accounts.length}</span>
      </div>

      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3">
        <div className="flex flex-col gap-[3px] pb-2">
          {!accountsLoaded && accounts.length === 0
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-[11px] px-[11px] py-2">
                  <Skeleton className="h-[30px] w-[30px] rounded-[9px]" />
                  <div className="min-w-0 flex-1">
                    <Skeleton className="mb-1.5 h-3 w-28" />
                    <Skeleton className="h-2.5 w-20" />
                  </div>
                </div>
              ))
            : accountsLoaded && accounts.length === 0
              ? (
                <div className="px-2 py-6 text-center text-xs text-[var(--faint)]">
                  No accounts yet. Connect Google Drive or Dropbox below.
                </div>
              )
              : null}

          {orderedAccounts.map((a) => (
            <AccountTile
              key={a.id}
              account={a}
              isActive={activeAccount === a.id}
              storage={storage[a.id]}
              meta={meta[a.id]}
              indexEntry={indexEntries[a.id]}
              emailError={emailErrors[a.id]}
              confirming={confirmRemove === a.id}
              onSelect={selectAccount}
              onRemove={handleRemove}
              onRetryEmail={fetchEmail}
              onToggleConfirm={toggleConfirmRemove}
              onMove={onMoveAccount}
            />
          ))}
        </div>
      </div>

      {/* Connect account — OUTSIDE the scrolling list so its upward-opening menu
          isn't clipped by the list's overflow (that was hiding the Drive item). */}
      <div className="relative shrink-0 px-3 pb-2">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center justify-center gap-1.5 rounded-[11px] border border-dashed border-[var(--line2)] py-2.5 text-xs font-semibold text-[var(--mut)] hover:border-[var(--acc)] hover:text-[var(--ink)]"
        >
          <Plus size={14} /> Connect account
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
            <div className="animate-pop absolute bottom-[46px] left-3 right-3 z-40 overflow-hidden rounded-[10px] border border-[var(--line2)] bg-[var(--card)] py-1 shadow-[var(--shadow-lg)]">
              {(["drive", "dropbox"] as Provider[]).map((p) => (
                <button
                  key={p}
                  onClick={() => { setAddProvider(p); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
                >
                  <ProviderIcon provider={p} size={15} /> {providerName(p)}
                </button>
              ))}
              <button
                onClick={() => { setAddLink(true); setMenuOpen(false); }}
                className="flex w-full items-center gap-2 border-t border-[var(--line)] px-3 py-2 text-left text-[13px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
              >
                <LinkIcon size={15} /> Shared link
              </button>
            </div>
          </>
        )}
      </div>

      {/* Footer: speed + theme toggle */}
      <div className="shrink-0 border-t border-[var(--line)] p-3">
        <div className="mb-2.5 flex items-center gap-2.5 px-1">
          <span className={`h-1.5 w-1.5 rounded-full ${totalSpeed > 0 ? "bg-[var(--dl)]" : "bg-[var(--line2)]"}`} />
          <div className="min-w-0 flex-1">
            <div className="tnum text-[12.5px] text-[var(--ink)]">{totalSpeed > 0 ? <span className="text-[var(--dl)]">{formatSpeed(totalSpeed)}</span> : "Idle"}</div>
          </div>
          <span className="font-mono text-[10px] text-[var(--faint)]">UNLIMITED</span>
        </div>
      </div>

      {addProvider && <AddAccountDialog provider={addProvider} onClose={() => setAddProvider(null)} />}
      {addLink && <AddLinkDialog onClose={() => setAddLink(false)} />}
    </aside>
  );
}

function NavItem({ icon, label, active, onClick, badge }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void; badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-10 items-center gap-3 rounded-[11px] px-[13px] text-[13.5px] transition active:translate-y-px ${
        active ? "bg-[var(--accw)] font-semibold text-[var(--acc)]" : "font-medium text-[var(--mut)] hover:bg-[var(--soft)]"
      }`}
    >
      <span className="flex w-[18px] shrink-0 justify-center">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge != null && <span className="tnum rounded-full bg-[var(--accent)] px-[7px] py-px text-[11px] font-semibold text-[var(--accent-ink)]">{badge}</span>}
    </button>
  );
}

/**
 * One account row. Memoized: Sidebar re-renders every 1s while a download is
 * active (jobs/queue drive the nav badges + footer speed), but a tile's own
 * data — storage/meta/index progress — usually hasn't changed on that tick,
 * so without this every tile would re-render anyway.
 */
const AccountTile = memo(function AccountTile({
  account: a,
  isActive,
  storage: st,
  meta: m,
  indexEntry: ie,
  emailError,
  confirming,
  onSelect,
  onRemove,
  onRetryEmail,
  onToggleConfirm,
  onMove,
}: {
  account: Account;
  isActive: boolean;
  storage?: Storage;
  meta?: Meta;
  indexEntry?: IndexEntry;
  emailError?: string;
  confirming: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRetryEmail: (id: string, force?: boolean) => void;
  onToggleConfirm: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const indexing = ie && (ie.status === "crawling" || ie.status === "loading");
  const pct = st && st.total > 0 ? Math.min(100, Math.round((st.used / st.total) * 100)) : null;
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const commitRename = () => {
    const v = renameVal.trim();
    if (v) useAccountMeta.getState().setLabel(a.id, v);
    setRenaming(false);
  };

  return (
    <div
      className={`group cursor-pointer rounded-[11px] px-[11px] py-2 transition-colors ${isActive ? "bg-[var(--soft)]" : "hover:bg-[var(--soft)]"}`}
      onClick={() => onSelect(a.id)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuPos({ x: e.clientX, y: e.clientY }); }}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--line)] bg-[var(--soft)]">
          <ProviderIcon provider={a.provider} size={17} />
        </span>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={commitRename}
              className="w-full rounded-[6px] border border-[var(--accent)] bg-[var(--card)] px-1.5 py-0.5 text-[12.5px] font-semibold text-[var(--ink)] focus-accent"
            />
          ) : (
            <div className="truncate text-[12.5px] font-semibold text-[var(--ink)]">{accountLabel(m?.label, a)}</div>
          )}
          <div className="flex items-center gap-1.5 truncate text-[11px] text-[var(--faint)]">
            <span className="truncate" data-tip={m?.email}>
              {providerName(a.provider)}
              {pct != null ? ` · ${pct}% full` : m?.email ? ` · ${m?.email}` : ""}
            </span>
            {!m?.email && emailError && (
              <button
                onClick={(e) => { e.stopPropagation(); onRetryEmail(a.id, true); }}
                data-tip={emailError}
                aria-label="Email lookup failed, retry"
                className="shrink-0 text-[var(--warn)] hover:text-[var(--ink)]"
              >
                <AlertCircle size={12} />
              </button>
            )}
          </div>
        </div>
        <button
          aria-label={`${a.label} options`}
          data-tip="Options"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenuPos({ x: r.right, y: r.bottom + 4 });
          }}
          className="shrink-0 scale-75 text-[var(--faint)] opacity-0 transition hover:text-[var(--ink)] group-hover:scale-100 group-hover:opacity-100"
        >
          <MoreHorizontal size={15} />
        </button>
      </div>

      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
          items={
            [
              { label: "Rename", icon: Pencil, onClick: () => { setRenameVal(accountLabel(m?.label, a)); setRenaming(true); } },
              { label: "Move up", icon: ArrowUp, onClick: () => onMove(a.id, -1) },
              { label: "Move down", icon: ArrowDown, onClick: () => onMove(a.id, 1) },
              { label: "Re-index", icon: FolderSearch, onClick: () => useIndex.getState().recrawl(a) },
              { label: "Remove", icon: Trash2, danger: true, separator: true, onClick: () => onToggleConfirm(a.id) },
            ] as MenuItem[]
          }
        />
      )}

      {pct != null && (
        <div className="mt-2">
          <div className="tnum mb-1 text-[10.5px] text-[var(--faint)]">{formatBytes(st!.used)} of {formatBytes(st!.total)}</div>
          <div className="h-1 overflow-hidden rounded-full bg-[var(--line)]">
            <div className="h-full rounded-full bg-[var(--acc)]" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {indexing && (
        <div className="mt-2">
          <div className="tnum mb-1 flex items-center gap-1.5 text-[10.5px] text-[var(--acc)]">
            <Loader2 size={11} className="animate-spin" />
            Indexing {ie!.progress.total > 0 ? `${ie!.progress.done}/${ie!.progress.total}` : "…"} · {ie!.progress.files.toLocaleString()} files
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[var(--line)]">
            <div className="h-full rounded-full bg-[var(--acc)]" style={{ width: ie!.progress.total > 0 ? `${Math.round((ie!.progress.done / ie!.progress.total) * 100)}%` : "8%" }} />
          </div>
        </div>
      )}

      {confirming && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-[var(--mut)]">Remove?</span>
          <button className="font-semibold text-[var(--err)]" onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}>Confirm</button>
          <button className="text-[var(--faint)]" onClick={(e) => { e.stopPropagation(); onToggleConfirm(a.id); }}>Cancel</button>
        </div>
      )}
    </div>
  );
});
