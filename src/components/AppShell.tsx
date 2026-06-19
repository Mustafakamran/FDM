import { Users, Settings as SettingsIcon, X } from "lucide-react";
import { useApp } from "../store/app";
import { useTransfers } from "../store/transfers";
import { ProviderIcon } from "./icons";
import { AccountsView } from "./AccountsView";
import { SettingsView } from "./SettingsView";
import { ProfileView } from "./ProfileView";
import { TransfersDock } from "./TransfersDock";
import { formatSpeed } from "../lib/format";

export function AppShell() {
  const { view, setView, accounts, openTabs, openProfile, closeTab } = useApp();
  const jobs = useTransfers((s) => s.jobs);
  const activeJobs = jobs.filter((j) => !j.finished && !j.cancelled);
  const totalSpeed = activeJobs.reduce((sum, j) => sum + Math.max(0, j.speed), 0);

  const navActive = (kind: "accounts" | "settings") =>
    view.kind === kind
      ? "text-[var(--text)] bg-[var(--hover)]"
      : "text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--hover)]";

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-3">
        <span className="mr-3 select-none text-sm font-semibold tracking-tight text-[var(--text)]">
          Footage Downloader
        </span>
        <button
          className="focus-accent flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-sm transition-colors"
          onClick={() => setView({ kind: "accounts" })}
        >
          <span className={`flex items-center gap-2 rounded-[6px] px-2 py-1 ${navActive("accounts")}`}>
            <Users size={16} /> Accounts
          </span>
        </button>
        <button
          className="focus-accent flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-sm transition-colors"
          onClick={() => setView({ kind: "settings" })}
        >
          <span className={`flex items-center gap-2 rounded-[6px] px-2 py-1 ${navActive("settings")}`}>
            <SettingsIcon size={16} /> Settings
          </span>
        </button>
      </header>

      {/* Profile tabs */}
      {openTabs.length > 0 && (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-2">
          {openTabs.map((id) => {
            const acc = accounts.find((a) => a.id === id);
            if (!acc) return null;
            const active = view.kind === "profile" && view.id === id;
            return (
              <div
                key={id}
                className={`group flex items-center gap-2 rounded-t-[6px] px-3 py-1.5 text-sm ${
                  active
                    ? "bg-[var(--bg)] text-[var(--text)] border-b-2 border-[var(--accent)]"
                    : "text-[var(--text-2)] hover:bg-[var(--hover)]"
                }`}
              >
                <button className="flex items-center gap-2" onClick={() => openProfile(id)}>
                  <ProviderIcon provider={acc.provider} size={14} />
                  <span className="max-w-[140px] truncate">{acc.label}</span>
                </button>
                <button
                  className="text-[var(--text-3)] hover:text-[var(--text)]"
                  onClick={() => closeTab(id)}
                  aria-label={`Close ${acc.label}`}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Content + transfers dock */}
      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 flex-1 overflow-auto">
          {view.kind === "accounts" && <AccountsView />}
          {view.kind === "settings" && <SettingsView />}
          {view.kind === "profile" && <ProfileView id={view.id} />}
        </main>
        <TransfersDock />
      </div>

      {/* Status bar */}
      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text-3)]">
        <span>
          <span className="tnum text-[var(--text-2)]">{activeJobs.length}</span> active
        </span>
        <span>
          ↓ <span className="tnum text-[var(--text-2)]">{formatSpeed(totalSpeed)}</span>
        </span>
        <span className="ml-auto">{accounts.length} account{accounts.length === 1 ? "" : "s"}</span>
      </footer>
    </div>
  );
}
