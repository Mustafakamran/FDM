import { X, FolderPlus, Bell } from "lucide-react";
import { useNotifications } from "../store/notifications";
import { ProviderIcon } from "./icons";
import { formatBytes, formatDate } from "../lib/format";

export function NotificationsPanel() {
  const { panelOpen, items, togglePanel, clear } = useNotifications();
  if (!panelOpen) return null;

  return (
    <div className="fixed right-3 top-12 z-[90] flex max-h-[70vh] w-96 flex-col overflow-hidden rounded-[11px] border border-[var(--border-strong)] bg-[var(--card)] shadow-[var(--shadow-lg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Bell size={15} /> Activity
        </span>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button className="text-xs text-[var(--text-3)] hover:text-[var(--text)]" onClick={() => clear()}>
              Clear
            </button>
          )}
          <button
            className="text-[var(--text-3)] hover:text-[var(--text)]"
            onClick={() => togglePanel(false)}
            aria-label="Close activity"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <FolderPlus size={22} className="text-[var(--text-3)]" />
          <p className="text-sm text-[var(--text-2)]">No new folders yet.</p>
          <p className="text-xs text-[var(--text-3)]">
            You'll be alerted when a client drops a new folder in any connected account.
          </p>
        </div>
      ) : (
        <div className="flex flex-col overflow-auto">
          {items.map((n) => (
            <div key={n.id} className="flex gap-3 border-b border-[var(--border)]/60 px-4 py-3">
              <span className="mt-0.5 text-[var(--accent)]">
                <FolderPlus size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[var(--text)]" title={n.folderName}>
                  {n.folderName}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--text-3)]">
                  <span className="flex items-center gap-1">
                    <ProviderIcon provider={n.provider} size={12} /> {n.accountLabel}
                  </span>
                  <span>·</span>
                  <span className="tnum">
                    {n.size === null ? "calculating…" : formatBytes(n.size)}
                  </span>
                  <span>·</span>
                  <span>{formatDate(n.modTime)}</span>
                  {n.uploader && (
                    <>
                      <span>·</span>
                      <span className="text-[var(--text-2)]">by {n.uploader}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
