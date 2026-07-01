import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Search, Settings as SettingsIcon, Bell, Minus, Square, X } from "lucide-react";
import { useApp } from "../store/app";
import { useSearch } from "../store/search";
import { useNotifications, unreadCount } from "../store/notifications";
import { useUI } from "../store/ui";
import { Logo } from "./ui/Logo";

const appWindow = getCurrentWindow();

export function TopBar() {
  const showHome = useApp((s) => s.showHome);
  const openSettings = useUI((s) => s.openSettings);
  const q = useSearch((s) => s.q);
  const setQ = useSearch((s) => s.set);
  const notifications = useNotifications((s) => s.items);
  const togglePanel = useNotifications((s) => s.togglePanel);
  const unread = unreadCount(notifications);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    const un = appWindow.onResized(() => appWindow.isMaximized().then(setMaximized).catch(() => {}));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  return (
    <header data-tauri-drag-region className="flex h-14 shrink-0 select-none items-center gap-3 bg-transparent pl-4 pr-2">
      {/* Brand — the single logo, home button. */}
      <button onClick={showHome} aria-label="Home" data-tip="Dashboard" className="shrink-0">
        <Logo size={30} wordSize={15} />
      </button>

      {/* Search */}
      <div className="mx-auto flex w-full max-w-xl items-center gap-2 rounded-[11px] border border-[var(--line)] bg-[var(--card)] px-3.5 py-2 text-sm focus-within:border-[var(--acc)]">
        <Search size={15} className="text-[var(--faint)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files and folders…"
          className="w-full bg-transparent text-[var(--ink)] placeholder:text-[var(--faint)] focus:outline-none"
        />
        {q && (
          <button onClick={() => setQ("")} aria-label="Clear search" className="text-[var(--faint)] hover:text-[var(--ink)]">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => togglePanel()}
          aria-label="Activity"
          data-tip="Activity"
          className="relative flex h-9 w-9 items-center justify-center rounded-full text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
        >
          <Bell size={16} />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--dl)] px-1 text-[10px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
        <button
          onClick={openSettings}
          aria-label="Settings"
          data-tip="Settings"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
        >
          <SettingsIcon size={16} />
        </button>

        <div className="ml-1 flex items-center gap-0.5">
          <button onClick={() => appWindow.minimize()} aria-label="Minimize" className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
            <Minus size={15} />
          </button>
          <button onClick={() => appWindow.toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"} className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]">
            <Square size={13} />
          </button>
          <button onClick={() => appWindow.close()} aria-label="Close" className="flex h-8 w-9 items-center justify-center rounded-[6px] text-[var(--mut)] hover:bg-[var(--err)] hover:text-white">
            <X size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
