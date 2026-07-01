import { useEffect, type ReactNode } from "react";
import { HardDrive, Download, Database, FileStack, Globe, ArrowRight, CheckCircle2 } from "lucide-react";
import { useApp } from "../store/app";
import { useStorage } from "../store/storage";
import { useTransfers } from "../store/transfers";
import { useHistory } from "../store/history";
import { useIndex } from "../store/index-store";
import { useAccountMeta, prettyLabel } from "../store/account-meta";
import { ProviderIcon, providerName } from "./icons";
import { formatBytes, formatSpeed } from "../lib/format";
import { SpeedTestCard } from "./SpeedTestCard";

/** At-a-glance landing: accounts, storage, live downloads, indexed files. */
export function Dashboard() {
  const accounts = useApp((s) => s.accounts);
  const selectAccount = useApp((s) => s.selectAccount);
  const showDownloads = useApp((s) => s.showDownloads);
  const showWebDownloads = useApp((s) => s.showWebDownloads);
  const storage = useStorage((s) => s.byAccount);
  const fetchStorage = useStorage((s) => s.fetch);
  const jobs = useTransfers((s) => s.jobs);
  const queue = useTransfers((s) => s.queue);
  const history = useHistory((s) => s.items);
  const indexEntries = useIndex((s) => s.byAccount);
  const meta = useAccountMeta((s) => s.byId);

  useEffect(() => {
    for (const a of accounts) void fetchStorage(a);
  }, [accounts, fetchStorage]);

  const active = jobs.filter((j) => !j.finished && !j.cancelled);
  const totalSpeed = active.reduce((s, j) => s + Math.max(0, j.speed), 0);
  const activeCount = active.length + queue.filter((q) => !q.paused).length;
  const completed = history.filter((h) => h.status === "success").length;

  const totalUsed = accounts.reduce((s, a) => s + (storage[a.id]?.used ?? 0), 0);
  const totalCap = accounts.reduce((s, a) => s + (storage[a.id]?.total ?? 0), 0);

  // Files counted only from accounts that have been indexed (opt-in), so this is
  // "known files" — zero when nothing's been indexed yet.
  const filesIndexed = Object.values(indexEntries).reduce((n, e) => {
    if (!e.index) return n;
    return n + Object.values(e.index.tree).reduce((m, arr) => m + arr.filter((i) => !i.IsDir).length, 0);
  }, 0);

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
        <Stat icon={<FileStack size={18} />} label="Files indexed" value={filesIndexed > 0 ? filesIndexed.toLocaleString() : "—"} sub={filesIndexed > 0 ? "across indexed drives" : "index a drive to count"} />
      </div>

      {/* Active downloads */}
      <Section title="Live downloads" action={activeCount > 0 ? { label: "Open Downloads", onClick: () => showDownloads("active") } : undefined}>
        {active.length === 0 ? (
          <div className="flex items-center gap-3 rounded-[15px] border border-[var(--line)] bg-[var(--card)] px-5 py-6 text-[13px] text-[var(--faint)]">
            <CheckCircle2 size={16} className="text-[var(--ok)]" /> No active downloads. Pick files in a drive and hit Download, or grab a URL from the web.
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {active.slice(0, 4).map((j) => {
              const pct = j.totalBytes > 0 ? Math.min(100, Math.round((j.bytes / j.totalBytes) * 100)) : 0;
              return (
                <div key={j.jobId} className="rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-4">
                  <div className="mb-2.5 flex items-center gap-3">
                    <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{j.name}</span>
                    <span className="tnum ml-auto text-[12.5px] font-semibold text-[var(--dl)]">{pct}%</span>
                  </div>
                  <div className="h-[6px] overflow-hidden rounded-full bg-[var(--soft)]">
                    <div className="h-full rounded-full bg-[var(--dl)]" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 font-mono text-[11.5px] text-[var(--faint)]">
                    {formatBytes(j.bytes)} of {formatBytes(j.totalBytes || j.bytes)} · <span className="text-[var(--dl)]">{formatSpeed(j.speed)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Connection speed */}
      <Section title="Connection">
        <SpeedTestCard />
      </Section>

      {/* Accounts */}
      <Section title="Your drives" action={{ label: "Web downloads", onClick: () => showWebDownloads() }}>
        {accounts.length === 0 ? (
          <div className="rounded-[15px] border border-dashed border-[var(--line2)] px-5 py-8 text-center text-[13px] text-[var(--faint)]">
            No drives yet — connect Google Drive or Dropbox from the sidebar.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
            {accounts.map((a) => {
              const st = storage[a.id];
              const pct = st && st.total > 0 ? Math.min(100, Math.round((st.used / st.total) * 100)) : null;
              return (
                <button
                  key={a.id}
                  onClick={() => selectAccount(a.id)}
                  className="group flex flex-col gap-3 rounded-[15px] border border-[var(--line)] bg-[var(--card)] p-4 text-left hover:border-[var(--line2)]"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] border border-[var(--line)] bg-[var(--soft)]">
                      <ProviderIcon provider={a.provider} size={19} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold text-[var(--ink)]">{meta[a.id]?.label ?? prettyLabel(a.label)}</div>
                      <div className="truncate text-[12px] text-[var(--faint)]">{providerName(a.provider)}{meta[a.id]?.email ? ` · ${meta[a.id]?.email}` : ""}</div>
                    </div>
                    <ArrowRight size={16} className="text-[var(--faint)] opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  {pct != null ? (
                    <div>
                      <div className="tnum mb-1 flex justify-between font-mono text-[11px] text-[var(--faint)]">
                        <span>{formatBytes(st!.used)} of {formatBytes(st!.total)}</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-[6px] overflow-hidden rounded-full bg-[var(--soft)]">
                        <div className="h-full rounded-full bg-[var(--acc)]" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11.5px] text-[var(--faint)]">Storage usage unavailable</div>
                  )}
                </button>
              );
            })}
          </div>
        )}
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
      <span className={`flex h-9 w-9 items-center justify-center rounded-[10px] ${accent ? "bg-[var(--dl)] text-white" : "bg-[var(--accw)] text-[var(--acc)]"}`}>{icon}</span>
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
