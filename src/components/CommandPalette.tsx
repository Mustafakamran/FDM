import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Home, Download, Globe, Settings as SettingsIcon, Sun, Moon, Zap, Search as SearchIcon } from "lucide-react";
import { usePalette } from "../store/palette";
import { useApp } from "../store/app";
import { useUI } from "../store/ui";
import { useTheme } from "../store/theme";
import { ProviderIcon, providerName } from "./icons";
import { useAccountMeta, accountLabel } from "../store/account-meta";

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

/**
 * Cmd/Ctrl+K global command palette — jump to any view or connected account,
 * toggle theme, open Settings, without touching the mouse. The single global
 * keydown listener lives here (not scattered per-component) since this is
 * the one thing that has to work from anywhere in the app.
 */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const setOpen = usePalette((s) => s.setOpen);
  const toggle = usePalette((s) => s.toggle);

  const accounts = useApp((s) => s.accounts);
  const selectAccount = useApp((s) => s.selectAccount);
  const showHome = useApp((s) => s.showHome);
  const showDownloads = useApp((s) => s.showDownloads);
  const showWebDownloads = useApp((s) => s.showWebDownloads);
  const openSettings = useUI((s) => s.openSettings);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const meta = useAccountMeta((s) => s.byId);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global open shortcut: Cmd/Ctrl+K, from anywhere (even inside another input).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const actions: PaletteAction[] = useMemo(() => {
    const list: PaletteAction[] = [
      { id: "home", label: "Go to Home", icon: <Home size={16} />, run: showHome },
      { id: "downloads", label: "Go to Downloads", icon: <Download size={16} />, run: () => showDownloads("active") },
      { id: "web-downloads", label: "Go to Web Downloads", icon: <Globe size={16} />, run: showWebDownloads },
      { id: "settings", label: "Open Settings", icon: <SettingsIcon size={16} />, keywords: "preferences config", run: openSettings },
      {
        id: "theme",
        label: theme === "dark" ? "Switch to Light theme" : "Switch to Dark theme",
        icon: theme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        keywords: "appearance dark light mode",
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
      {
        id: "speed-test",
        label: "Run a speed test",
        hint: "Home",
        icon: <Zap size={16} />,
        keywords: "connection bandwidth mbps",
        run: showHome,
      },
    ];
    for (const a of accounts) {
      list.push({
        id: `account-${a.id}`,
        label: `Open ${accountLabel(meta[a.id]?.label, a)}`,
        hint: providerName(a.provider),
        icon: <ProviderIcon provider={a.provider} size={16} />,
        keywords: `${a.provider} files browse`,
        run: () => selectAccount(a.id),
      });
    }
    return list;
  }, [accounts, meta, theme, showHome, showDownloads, showWebDownloads, openSettings, setTheme, selectAccount]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => `${a.label} ${a.keywords ?? ""} ${a.hint ?? ""}`.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => setActiveIndex(0), [query]);

  function run(a: PaletteAction) {
    a.run();
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[activeIndex];
      if (a) run(a);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center bg-black/20 pt-[15vh]"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="animate-rise w-full max-w-lg overflow-hidden rounded-[14px] border border-[var(--border-strong)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
          <SearchIcon size={16} className="shrink-0 text-[var(--text-3)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a view, account, or action…"
            className="w-full bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-3)] focus:outline-none"
          />
          <kbd className="shrink-0 rounded-[5px] border border-[var(--border)] bg-[var(--hover)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-3)]">Esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-[var(--text-3)]">No matches.</div>
          ) : (
            filtered.map((a, i) => (
              <button
                key={a.id}
                onClick={() => run(a)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left text-sm ${
                  i === activeIndex ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-2)]"
                }`}
              >
                <span className="shrink-0 text-[var(--text-3)]">{a.icon}</span>
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                {a.hint && <span className="shrink-0 text-xs text-[var(--text-3)]">{a.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
