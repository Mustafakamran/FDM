import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persisted";

const KEY = "app_settings_v1";

export interface AppSettings {
  /**
   * Auto-build the background folder index for each drive on open, so every
   * folder's total size AND file count show by default. The crawl runs on
   * background threads (progress shown, cancellable) and is persisted, so a
   * drive is only crawled once. When OFF, fall back to the per-folder "Index"
   * / "Calculate size" on-demand actions.
   *
   * Defaults OFF: a Drive account's crawl root includes "Shared with me"
   * (see account_fs), which for this app's core use case is a multi-TB corpus
   * of client footage — auto-walking it on first open would burn Drive API
   * quota and hammer the same daemon that serves live browsing. Opt-in.
   */
  autoIndex: boolean;
}

const DEFAULTS: AppSettings = { autoIndex: false };

function load(): AppSettings {
  return { ...DEFAULTS, ...loadJson<Partial<AppSettings>>(KEY, {}) };
}

interface SettingsState extends AppSettings {
  setAutoIndex: (v: boolean) => void;
}

export const useSettings = create<SettingsState>((set) => ({
  ...load(),

  setAutoIndex: (autoIndex) => {
    saveJson(KEY, { autoIndex });
    set({ autoIndex });
  },
}));
