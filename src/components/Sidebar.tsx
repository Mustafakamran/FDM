import { useEffect, useState, type ReactNode } from "react";
import { Plus, Home, FolderOpen, Download, AlertCircle, Globe, Trash2, Loader2, Link as LinkIcon, Sun, Moon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "../store/app";
import { useTransfers } from "../store/transfers";
import { useStorage } from "../store/storage";
import { useAccountMeta, prettyLabel } from "../store/account-meta";
import { useIndex } from "../store/index-store";
import { useTheme } from "../store/theme";
import { ProviderIcon, providerName } from "./icons";
import { Skeleton } from "./ui";
import { AddAccountDialog } from "./AddAccountDialog";
import { AddLinkDialog } from "./AddLinkDialog";
import { formatBytes, formatSpeed } from "../lib/format";
import { laneOf } from "../lib/lane";
import type { Provider } from "../lib/tauri/commands";

export function Sidebar() {
  const { view, accounts, accountsLoaded, selectAccount, removeAccount, showDownloads, showWebDownloads, setView } = useApp(
    useShallow((s) => ({
      view: s.view,
      accounts: s.accounts,
      accountsLoaded: s.accountsLoaded,
      selectAccount: s.selectAccount,
      removeAccount: s.removeAccount,
      showDownloads: s.showDownloads,
      showWebDownloads: s.showWebDownloads,
      setView: s.setView,
    })),
  );
  const onWeb = view.kind === "downloads" && !!view.web;
  const onDownloads = view.kind === "downloads" && !view.web;
  const onFiles = view.kind === "browse";
  const onHome = view.kind === "home";
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const storage = useStorage((s) => s.byAccount);
  const fetchStorage = useStorage((s) => s.fetch);
  const meta = useAccountMeta((s) => s.byId);
  const indexEntries = useIndex((s) => s.byAccount);
  const emailErrors = useAccountMeta((s) => s.errors);
  const fetchEmail = useAccountMeta((s) => s.fetchEmail);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
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

  const active = jobs.filter((j) => !j.finished && !j.cancelled);
  const counts = {
    downloading: active.length + queue.filter((q) => !q.paused).length,
    web:
      active.filter((j) => laneOf(j.accountId) === "secondary").length +
      queue.filter((q) => laneOf(q.accountId) === "secondary" && !q.paused).length,
  };
  const totalSpeed = active.reduce((s, j) => s + Math.max(0, j.speed), 0);

  const goFiles = () => {
    if (activeAccount) return;
    if (accounts[0]) selectAccount(accounts[0].id);
  };

  return (
    <aside className="flex w-[236px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)]">
      {/* Primary nav (the brand lives in the top bar now). */}
      <div className="flex flex-col gap-0.5 px-3 pt-4">
        <NavItem icon={<Home size={16} />} label="Home" active={onHome} onClick={() => setView({ kind: "home" })} />
        <NavItem icon={<FolderOpen size={16} />} label="Files" active={onFiles} onClick={goFiles} />
        <NavItem icon={<Download size={16} />} label="Downloads" active={onDownloads} onClick={() => showDownloads("active")} badge={counts.downloading || undefined} />
        <NavItem icon={<Globe size={16} />} label="Web Downloads" active={onWeb} onClick={() => showWebDownloads()} badge={counts.web || undefined} />
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

          {accounts.map((a) => {
            const st = storage[a.id];
            const isActive = activeAccount === a.id;
            const ie = indexEntries[a.id];
            const indexing = ie && (ie.status === "crawling" || ie.status === "loading");
            const pct = st && st.total > 0 ? Math.min(100, Math.round((st.used / st.total) * 100)) : null;
            return (
              <div
                key={a.id}
                className={`group cursor-pointer rounded-[11px] px-[11px] py-2 ${isActive ? "bg-[var(--soft)]" : "hover:bg-[var(--soft)]"}`}
                onClick={() => selectAccount(a.id)}
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--line)] bg-[var(--soft)]">
                    <ProviderIcon provider={a.provider} size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-semibold text-[var(--ink)]">{meta[a.id]?.label ?? prettyLabel(a.label)}</div>
                    <div className="flex items-center gap-1.5 truncate text-[11px] text-[var(--faint)]">
                      <span className="truncate" data-tip={meta[a.id]?.email}>
                        {providerName(a.provider)}
                        {pct != null ? ` · ${pct}% full` : meta[a.id]?.email ? ` · ${meta[a.id]?.email}` : ""}
                      </span>
                      {!meta[a.id]?.email && emailErrors[a.id] && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void fetchEmail(a.id, true); }}
                          data-tip={emailErrors[a.id]}
                          aria-label="Email lookup failed, retry"
                          className="shrink-0 text-[var(--warn)] hover:text-[var(--ink)]"
                        >
                          <AlertCircle size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  <button
                    aria-label={`Remove ${a.label}`}
                    data-tip={`Remove ${a.label}`}
                    onClick={(e) => { e.stopPropagation(); setConfirmRemove(confirmRemove === a.id ? null : a.id); }}
                    className="shrink-0 text-[var(--faint)] opacity-0 hover:text-[var(--err)] group-hover:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

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

                {confirmRemove === a.id && (
                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <span className="text-[var(--mut)]">Remove?</span>
                    <button className="font-semibold text-[var(--err)]" onClick={(e) => { e.stopPropagation(); void removeAccount(a.id); setConfirmRemove(null); }}>Confirm</button>
                    <button className="text-[var(--faint)]" onClick={(e) => { e.stopPropagation(); setConfirmRemove(null); }}>Cancel</button>
                  </div>
                )}
              </div>
            );
          })}
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
        <div className="flex items-center gap-1 rounded-[11px] bg-[var(--soft)] p-1">
          <button
            onClick={() => setTheme("light")}
            className={`flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-[8px] text-[12px] font-semibold ${theme === "light" ? "bg-[var(--card)] text-[var(--ink)] shadow-[var(--shadow-sm)]" : "text-[var(--faint)] hover:text-[var(--mut)]"}`}
          >
            <Sun size={13} /> Light
          </button>
          <button
            onClick={() => setTheme("dark")}
            className={`flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-[8px] text-[12px] font-semibold ${theme === "dark" ? "bg-[var(--card)] text-[var(--ink)] shadow-[var(--shadow-sm)]" : "text-[var(--faint)] hover:text-[var(--mut)]"}`}
          >
            <Moon size={13} /> Dark
          </button>
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
      className={`flex h-10 items-center gap-3 rounded-[11px] px-[13px] text-[13.5px] ${
        active ? "bg-[var(--accw)] font-semibold text-[var(--acc)]" : "font-medium text-[var(--mut)] hover:bg-[var(--soft)]"
      }`}
    >
      <span className="flex w-[18px] shrink-0 justify-center">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge != null && <span className="tnum rounded-full bg-[var(--dl)] px-[7px] py-px text-[11px] font-semibold text-white">{badge}</span>}
    </button>
  );
}
