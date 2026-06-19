import { X } from "lucide-react";
import { useUI } from "../store/ui";
import { SettingsView } from "./SettingsView";

export function SettingsDialog() {
  const { settingsOpen, closeSettings } = useUI();
  if (!settingsOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-auto bg-black/60 p-8 backdrop-blur-sm"
      onClick={closeSettings}
    >
      <div
        className="animate-rise relative w-full max-w-2xl rounded-[14px] border border-[var(--border-strong)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={closeSettings}
          aria-label="Close settings"
          className="absolute right-4 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X size={16} />
        </button>
        <SettingsView />
      </div>
    </div>
  );
}
