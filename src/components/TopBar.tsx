import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Search, Settings as SettingsIcon, Bell, Sun, Moon, Minus, Square, X } from "lucide-react";
import { useApp } from "../store/app";
import { useSearch } from "../store/search";
import { useNotifications, unreadCount } from "../store/notifications";
import { useUI } from "../store/ui";
import { useTheme } from "../store/theme";
import { Logo } from "./ui/Logo";
import { GlobalSearchResults } from "./GlobalSearchResults";

const appWindow = getCurrentWindow();
const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

export function TopBar() {
  const showHome = useApp((s) => s.showHome);
  const openSettings = useUI((s) => s.openSettings);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const q = useSearch((s) => s.q);
  const setQ = useSearch((s) => s.set);
  const notifications = useNotifications((s) => s.items);
  const togglePanel = useNotifications((s) => s.togglePanel);
  const unread = unreadCount(notifications);
  const focusSeq = useSearch((s) => s.focusSeq);
  const requestFocus = useSearch((s) => s.focus);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  // The unified search dropdown (files + commands) opens on focus, Slack-style.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    const un = appWindow.onResized(() => appWindow.isMaximized().then(setMaximized).catch(() => {}));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  // Cmd/Ctrl+K focuses the one search box — it IS the command palette now
  // (files + commands live in the results). Works from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        requestFocus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestFocus]);

  // Focus + select the input whenever focus is requested (Cmd+K bumps focusSeq).
  useEffect(() => {
    if (focusSeq === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    setOpen(true);
  }, [focusSeq]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <header data-tauri-drag-region className="flex h-14 shrink-0 select-none items-center gap-3 bg-transparent pl-4 pr-2">
      {/* Brand — the single logo, home button. */}
      <button onClick={showHome} aria-label="Home" data-tip="Dashboard" className="shrink-0">
        <Logo size={30} wordSize={15} />
      </button>

      {/* Search + unified command/search dropdown */}
      <div ref={searchRef} className="relative mx-auto w-full max-w-xl">
        <div className={`flex items-center gap-2 border border-[var(--line)] bg-[var(--card)] px-3.5 py-2 text-sm transition-[border-radius] duration-150 ${open ? "rounded-t-[11px] rounded-b-none border-b-transparent" : "rounded-[11px] focus-within:border-[var(--acc)]"}`}>
          <Search size={15} className="text-[var(--faint)]" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQ(""); inputRef.current?.blur(); } }}
            placeholder="Search files, folders, or jump to anything…"
            className="w-full bg-transparent text-[var(--ink)] placeholder:text-[var(--faint)] focus:outline-none"
          />
          {q ? (
            <button onClick={() => setQ("")} aria-label="Clear search" className="text-[var(--faint)] hover:text-[var(--ink)]">
              <X size={14} />
            </button>
          ) : (
            <button
              onClick={() => requestFocus()}
              aria-label="Focus search"
              data-tip="Search"
              className="shrink-0 rounded-[5px] border border-[var(--line)] bg-[var(--soft)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--faint)] hover:text-[var(--mut)]"
            >
              {isMac ? "⌘K" : "Ctrl K"}
            </button>
          )}
        </div>
        {/* Results panel — merged with the search box: no gap, square top
            corners meeting the box's squared bottom, one continuous outline. */}
        {open && (
          <div className="animate-dropdown absolute left-0 right-0 top-full z-50">
            <GlobalSearchResults onClose={() => setOpen(false)} attached />
          </div>
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
            <span key={unread} className="animate-badge absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-[var(--accent-ink)]">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          data-tip={theme === "dark" ? "Light theme" : "Dark theme"}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--mut)] hover:bg-[var(--soft)] hover:text-[var(--ink)]"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
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
