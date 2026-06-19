import { useApp } from "../store/app";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { BrowsePane } from "./BrowsePane";
import { SettingsView } from "./SettingsView";
import { ConnectView } from "./ConnectView";
import { DownloadsDock } from "./DownloadsDock";
import { ToastHost } from "./ToastHost";
import { NotificationsPanel } from "./NotificationsPanel";

export function AppShell() {
  const { view, accounts } = useApp();
  const browseAccount = view.kind === "browse" ? accounts.find((a) => a.id === view.accountId) : undefined;

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <TopBar />
      <ToastHost />
      <NotificationsPanel />

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-h-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 overflow-hidden">
            {view.kind === "settings" && (
              <div className="h-full overflow-auto">
                <SettingsView />
              </div>
            )}
            {view.kind === "accounts" && <ConnectView />}
            {view.kind === "browse" &&
              (browseAccount ? (
                <BrowsePane account={browseAccount} section={view.section} path={view.path} />
              ) : (
                <ConnectView />
              ))}
          </main>
          <DownloadsDock />
        </div>
      </div>
    </div>
  );
}
