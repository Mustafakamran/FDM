import { useEffect, useRef } from "react";
import { X, FolderPlus, Bell, CheckCircle2 } from "lucide-react";
import { useNotifications } from "../store/notifications";
import { useApp } from "../store/app";
import { ProviderIcon } from "./icons";
import { openInFileManager } from "../lib/tauri/commands";
import { formatBytes, formatDate, formatDateTime } from "../lib/format";

export function NotificationsPanel() {
  const { panelOpen, items, togglePanel, clear } = useNotifications();
  const setView = useApp((s) => s.setView);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on click outside the panel (ignoring the Activity toggle button, so
  // clicking it still toggles rather than close-then-reopen).
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (panelRef.current?.contains(t) || t.closest("[data-notif-toggle]")) return;
      togglePanel(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [panelOpen, togglePanel]);

  if (!panelOpen) return null;

  const openNotification = (n: (typeof items)[number]) => {
    if (n.kind === "transfer") {
      // Open the download's destination folder in the OS file manager.
      if (n.dest) void openInFileManager(n.dest);
    } else {
      setView({ kind: "browse", accountId: n.accountId, section: "all", path: n.path });
    }
    togglePanel(false);
  };

  return (
    <div ref={panelRef} className="animate-pop fixed right-3 top-12 z-[90] flex max-h-[70vh] w-96 flex-col overflow-hidden rounded-[11px] border border-[var(--border-strong)] bg-[var(--card)] shadow-[var(--shadow-lg)]">
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
          <Bell size={22} className="text-[var(--text-3)]" />
          <p className="text-sm text-[var(--text-2)]">Nothing yet.</p>
          <p className="text-xs text-[var(--text-3)]">
            New client folders and finished transfers show up here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col overflow-auto">
          {items.map((n) => (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              onClick={() => openNotification(n)}
              onKeyDown={(e) => e.key === "Enter" && openNotification(n)}
              className="flex cursor-pointer gap-3 border-b border-[var(--border)]/60 px-4 py-3 hover:bg-[var(--hover)]"
            >
              <span className={`mt-0.5 ${n.kind === "transfer" ? "text-[var(--ok)]" : "text-[var(--accent)]"}`}>
                {n.kind === "transfer" ? <CheckCircle2 size={16} /> : <FolderPlus size={16} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[var(--text)]" title={n.folderName}>
                  {n.folderName}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--text-3)]">
                  <span className="flex items-center gap-1">
                    {n.provider && <ProviderIcon provider={n.provider} size={12} />} {n.accountLabel}
                  </span>
                  <span>·</span>
                  {n.kind === "transfer" ? (
                    <>
                      <span className="tnum">{n.size === null ? "" : formatBytes(n.size)}</span>
                      <span>·</span>
                      <span>{formatDateTime(n.at)}</span>
                    </>
                  ) : (
                    <>
                      <span className="tnum">{n.size === null ? "calculating…" : formatBytes(n.size)}</span>
                      <span>·</span>
                      <span>{formatDate(n.modTime)}</span>
                      {n.uploader && (
                        <>
                          <span>·</span>
                          <span className="text-[var(--text-2)]">by {n.uploader}</span>
                        </>
                      )}
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
