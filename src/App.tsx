import { useEffect } from "react";
import { AppShell } from "./components/AppShell";
import { useApp } from "./store/app";

export default function App() {
  const loadAccounts = useApp((s) => s.loadAccounts);

  useEffect(() => {
    loadAccounts().catch(() => {
      /* daemon may not be ready on first paint; AccountsView shows empty state */
    });
  }, [loadAccounts]);

  return <AppShell />;
}
