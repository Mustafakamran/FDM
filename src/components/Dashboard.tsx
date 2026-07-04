import { useEffect, type ReactNode } from "react";
import { HardDrive, Download, Database, FolderPlus, Globe, ArrowRight } from "lucide-react";
import { useApp } from "../store/app";
import { useStorage } from "../store/storage";
import { useTransfers } from "../store/transfers";
import { useHistory } from "../store/history";
import { formatBytes, formatSpeed } from "../lib/format";
import { useNewFolders } from "../lib/use-new-folders";
import { SpeedTestCard } from "./SpeedTestCard";

/** At-a-glance landing: accounts, active downloads, storage, and new folders. */
export function Dashboard() {
  const accounts = useApp((s) => s.accounts);
  const showDownloads = useApp((s) => s.showDownloads);
  const showNewFolders = useApp((s) => s.showNewFolders);
  const storage = useStorage((s) => s.byAccount);
  const fetchStorage = useStorage((s) => s.fetch);
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const history = useHistory((s) => s.items);
  const { count: newFolderCount, totalSize: newFolderSize, allSized } = useNewFolders();

  useEffect(() => {
    for (const a of accounts) void fetchStorage(a);
  }, [accounts, fetchStorage]);

  const active = jobs.filter((j) => !j.finished && !j.cancelled);
  const totalSpeed = active.reduce((s, j) => s + Math.max(0, j.speed), 0);
  const activeCount = active.length + queue.filter((q) => !q.paused).length;
  const completed = history.filter((h) => h.status === "success").length;

  const totalUsed = accounts.reduce((s, a) => s + (storage[a.id]?.used ?? 0), 0);
  const totalCap = accounts.reduce((s, a) => s + (storage[a.id]?.total ?? 0), 0);

  return (
    <div className="h-full overflow-auto px-8 py-7">
      {/* Header */}
      <div className="mb-7">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--faint)]">Dashboard</div>
        <h1 className="mt-1 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">Welcome back</h1>
        <p className="mt-1 text-[13.5px] text-[var(--mut)]">
          {accounts.length} {accounts.length === 1 ? "account" : "accounts"} connected ·{" "}
          {totalSpeed > 0 ? <span className="font-semibold text-[var(--dl)]">{formatSpeed(totalSpeed)} downloading</span> : "idle"}
        </p>
      </div>

      {/* Stat tiles */}
      {/* App's own min-width is 980px — well past Tailwind's `md` (768) — so a
          `lg` (1024) gate left this stuck at 2 columns for the entire usable
          range below 1024px. Step through 3 at the floor, 4 once there's
          genuinely room. */}
      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-4">
        <Stat icon={<HardDrive size={18} />} label="Connected drives" value={String(accounts.length)} sub={accountProviders(accounts)} />
        <Stat
          icon={<Download size={18} />}
          label="Active downloads"
          value={String(activeCount)}
          sub={totalSpeed > 0 ? `${formatSpeed(totalSpeed)} now` : "none running"}
          accent={activeCount > 0}
          onClick={() => showDownloads("active")}
        />
        <Stat icon={<Database size={18} />} label="Storage used" value={formatBytes(totalUsed)} sub={totalCap > 0 ? `of ${formatBytes(totalCap)}` : "—"} />
        <Stat
          icon={<FolderPlus size={18} />}
          label="New folders"
          value={newFolderCount > 0 ? String(newFolderCount) : "—"}
          sub={newFolderCount > 0 ? `${formatBytes(newFolderSize)}${allSized ? "" : "+"} to download` : "nothing new"}
          accent={newFolderCount > 0}
          onClick={() => showNewFolders()}
        />
      </div>

      {/* Connection speed */}
      <Section title="Connection">
        <SpeedTestCard />
      </Section>

      {/* Quick stat footer */}
      <div className="mt-7 flex items-center gap-2 text-[12px] text-[var(--faint)]">
        <Globe size={13} /> {completed.toLocaleString()} downloads completed all-time
      </div>
    </div>
  );
}

function Stat({ icon, label, value, sub, accent, onClick }: { icon: ReactNode; label: string; value: string; sub?: string; accent?: boolean; onClick?: () => void }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp onClick={onClick} className={`flex flex-col gap-3 rounded-[15px] border border-[var(--line)] bg-[var(--card)] p-4 text-left ${onClick ? "hover:border-[var(--line2)]" : ""}`}>
      <span className={`flex h-9 w-9 items-center justify-center rounded-[10px] ${accent ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--accw)] text-[var(--acc)]"}`}>{icon}</span>
      <div className="min-w-0">
        <div className="tnum truncate text-[24px] font-bold leading-none tracking-[-0.02em] text-[var(--ink)]">{value}</div>
        <div className="mt-1.5 truncate text-[12.5px] font-medium text-[var(--mut)]">{label}</div>
        {sub && <div className="mt-0.5 truncate text-[11.5px] text-[var(--faint)]">{sub}</div>}
      </div>
    </Comp>
  );
}

function Section({ title, action, children }: { title: string; action?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <div className="mt-7">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--faint)]">{title}</h2>
        {action && (
          <button onClick={action.onClick} className="flex items-center gap-1 text-[12px] font-semibold text-[var(--mut)] hover:text-[var(--ink)]">
            {action.label} <ArrowRight size={13} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function accountProviders(accounts: { provider: string }[]): string {
  const drive = accounts.filter((a) => a.provider === "drive").length;
  const dropbox = accounts.filter((a) => a.provider === "dropbox").length;
  const parts: string[] = [];
  if (drive) parts.push(`${drive} Drive`);
  if (dropbox) parts.push(`${dropbox} Dropbox`);
  return parts.join(" · ") || "none yet";
}
