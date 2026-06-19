import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Users, Settings as SettingsIcon, Minus, Square, X, Bell } from "lucide-react";
import { useApp } from "../store/app";
import { useNotifications, unreadCount } from "../store/notifications";

const appWindow = getCurrentWindow();

export function TitleBar() {
  const { view, setView } = useApp();
  const notifications = useNotifications((s) => s.items);
  const togglePanel = useNotifications((s) => s.togglePanel);
  const unread = unreadCount(notifications);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    const un = appWindow.onResized(() => {
      appWindow.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  const navItem = (kind: "accounts" | "settings", icon: React.ReactNode, label: string) => {
    const active = view.kind === kind;
    return (
      <button
        onClick={() => setView({ kind })}
        className={`flex items-center gap-2 rounded-[7px] px-2.5 py-1 text-sm transition-colors ${
          active
            ? "bg-[var(--hover)] text-[var(--text)]"
            : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        }`}
      >
        {icon} {label}
      </button>
    );
  };

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 select-none items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] pl-3 pr-2"
    >
      <span data-tauri-drag-region className="mr-2 flex items-center gap-2">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="var(--accent-weak)" stroke="var(--accent)" strokeWidth="1.2" />
          <path d="M12 6.5v8m0 0 3.2-3.2M12 14.5l-3.2-3.2M7.5 17.5h9" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-semibold tracking-tight text-[var(--text)]">
          Footage Download Manager
        </span>
        <span className="rounded-[5px] bg-[var(--hover)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--text-3)]">
          FDM
        </span>
      </span>

      {navItem("accounts", <Users size={15} />, "Accounts")}
      {navItem("settings", <SettingsIcon size={15} />, "Settings")}

      <div data-tauri-drag-region className="h-full flex-1" />

      <button
        onClick={() => togglePanel()}
        aria-label="Activity"
        className="relative mr-1 flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <Bell size={15} />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-[var(--accent-ink)]">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      <div className="flex items-center gap-0.5">
        <button
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
          className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          aria-label={maximized ? "Restore" : "Maximize"}
          className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <Square size={13} />
        </button>
        <button
          onClick={() => appWindow.close()}
          aria-label="Close"
          className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--text-2)] hover:bg-[var(--error)] hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  );
}
