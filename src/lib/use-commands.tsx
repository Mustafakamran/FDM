import { useMemo, type ReactNode } from "react";
import { Home, Download, Upload, Globe, FolderPlus, Settings as SettingsIcon, Sun, Moon, Zap } from "lucide-react";
import { useApp } from "../store/app";
import { useUI } from "../store/ui";
import { useTheme } from "../store/theme";
import { useAccountMeta, accountLabel } from "../store/account-meta";
import { ProviderIcon, providerName } from "../components/icons";

/** A navigation / action command, matchable by the unified search. */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

/**
 * The command/nav actions the old Cmd+K palette exposed — now surfaced inside
 * the unified search results (files + commands together). Jump to any view or
 * connected drive, toggle theme, open Settings.
 */
export function useCommands(): Command[] {
  const accounts = useApp((s) => s.accounts);
  const selectAccount = useApp((s) => s.selectAccount);
  const showHome = useApp((s) => s.showHome);
  const showDownloads = useApp((s) => s.showDownloads);
  const showUploads = useApp((s) => s.showUploads);
  const showWebDownloads = useApp((s) => s.showWebDownloads);
  const showNewFolders = useApp((s) => s.showNewFolders);
  const openSettings = useUI((s) => s.openSettings);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const meta = useAccountMeta((s) => s.byId);

  return useMemo(() => {
    const list: Command[] = [
      { id: "home", label: "Go to Home", icon: <Home size={16} />, run: showHome },
      { id: "downloads", label: "Go to Downloads", icon: <Download size={16} />, keywords: "transfers", run: () => showDownloads("active") },
      { id: "uploads", label: "Go to Uploads", icon: <Upload size={16} />, keywords: "send transfers", run: () => showUploads("active") },
      { id: "new-folders", label: "Go to New folders", icon: <FolderPlus size={16} />, keywords: "recent added", run: showNewFolders },
      { id: "web-downloads", label: "Go to Web Downloads", icon: <Globe size={16} />, keywords: "url http", run: showWebDownloads },
      { id: "settings", label: "Open Settings", icon: <SettingsIcon size={16} />, keywords: "preferences config", run: openSettings },
      {
        id: "theme",
        label: theme === "dark" ? "Switch to Light theme" : "Switch to Dark theme",
        icon: theme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        keywords: "appearance dark light mode",
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
      { id: "speed-test", label: "Run a speed test", hint: "Home", icon: <Zap size={16} />, keywords: "connection bandwidth mbps", run: showHome },
    ];
    for (const a of accounts) {
      list.push({
        id: `account-${a.id}`,
        label: `Open ${accountLabel(meta[a.id]?.label, a)}`,
        hint: providerName(a.provider),
        icon: <ProviderIcon provider={a.provider} size={16} />,
        keywords: `${a.provider} files browse drive`,
        run: () => selectAccount(a.id),
      });
    }
    return list;
  }, [accounts, meta, theme, showHome, showDownloads, showUploads, showWebDownloads, showNewFolders, openSettings, setTheme, selectAccount]);
}

/** Filter commands by a query (matches label + keywords + hint). */
export function filterCommands(commands: Command[], q: string): Command[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return commands.filter((c) => `${c.label} ${c.keywords ?? ""} ${c.hint ?? ""}`.toLowerCase().includes(needle));
}
