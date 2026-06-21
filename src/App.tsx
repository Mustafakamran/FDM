import { useEffect } from "react";
import { AppShell } from "./components/AppShell";
import { useApp } from "./store/app";
import { useUpdater } from "./store/updater";
import { useTransfers } from "./store/transfers";
import { startWatching, stopWatching } from "./lib/watcher";

export default function App() {
  const loadAccounts = useApp((s) => s.loadAccounts);

  useEffect(() => {
    loadAccounts()
      .then(() => {
        // Daemon is up and accounts are loaded — resume any downloads that were
        // queued or in flight when the app last closed (torrent-style).
        useTransfers.getState().resume();
      })
      .catch(() => {
        /* daemon may not be ready on first paint; AccountsView shows empty state */
      });
    startWatching();
    // Check for an OTA update shortly after launch (silent if none / no runtime).
    const t = setTimeout(() => void useUpdater.getState().check(), 3000);
    return () => {
      clearTimeout(t);
      stopWatching();
    };
  }, [loadAccounts]);

  return <AppShell />;
}
