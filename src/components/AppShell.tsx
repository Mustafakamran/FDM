import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "../store/app";
import { useSearch } from "../store/search";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { BrowsePane } from "./BrowsePane";
import { GlobalSearchResults } from "./GlobalSearchResults";
import { ReviewView } from "./ReviewView";
import { DownloadsView } from "./DownloadsView";
import { Dashboard } from "./Dashboard";
import { ConnectView } from "./ConnectView";
import { DownloadsDock } from "./DownloadsDock";
import { ToastHost } from "./ToastHost";
import { NotificationsPanel } from "./NotificationsPanel";
import { SettingsDialog } from "./SettingsDialog";
import { CommandPalette } from "./CommandPalette";
import { UpdateBanner } from "./UpdateBanner";
import { TooltipLayer } from "./ui/Tooltip";

export function AppShell() {
  const { view, accounts } = useApp(useShallow((s) => ({ view: s.view, accounts: s.accounts })));
  const browseAccount = view.kind === "browse" ? accounts.find((a) => a.id === view.accountId) : undefined;
  // A query in the top-bar search box takes over the content area with results
  // from EVERY connected drive (see GlobalSearchResults), regardless of which
  // view is underneath — that's the "search all drives" behaviour.
  const searching = useSearch((s) => s.q.trim().length > 0);
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);

  // Global Back/Forward: Alt+←/→ and the mouse back/forward buttons (button 3/4),
  // so navigation history works everywhere — matching a native file browser.
  useEffect(() => {
    const isEditable = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack Option/Alt+← word-navigation inside text fields.
      if (isEditable(e.target)) return;
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [goBack, goForward]);

  return (
    <div
      className="flex h-screen flex-col overflow-hidden rounded-[var(--window-radius)] border border-[var(--border)]"
      style={{ background: "var(--win)" }}
    >
      <TopBar />
      <UpdateBanner />
      <ToastHost />
      <NotificationsPanel />
      <SettingsDialog />
      <CommandPalette />
      <TooltipLayer />

      <div className="flex min-h-0 flex-1 gap-2.5 px-2.5 pb-2.5">
        <Sidebar />
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
          <div className="min-h-0 flex-1 overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)]">
            {searching ? (
              <GlobalSearchResults />
            ) : (
              <>
                {view.kind === "home" && <Dashboard />}
                {view.kind === "accounts" && <ConnectView />}
                {view.kind === "downloads" && <DownloadsView filter={view.filter} />}
                {view.kind === "review" && <ReviewView accountId={view.accountId} target={view.target} />}
                {view.kind === "browse" &&
                  (browseAccount ? (
                    <BrowsePane account={browseAccount} section={view.section} path={view.path} />
                  ) : (
                    <ConnectView />
                  ))}
              </>
            )}
          </div>
          {/* The Downloads/Web views show their own progress + total bar, so the
              dock would duplicate them there — only float it over other screens. */}
          {view.kind !== "downloads" && <DownloadsDock />}
        </div>
      </div>
    </div>
  );
}
