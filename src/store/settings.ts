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
   */
  autoIndex: boolean;
}

const DEFAULTS: AppSettings = { autoIndex: true };

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

// Non-reactive read for effects/imperatives.
export const getSettings = (): AppSettings => ({ autoIndex: useSettings.getState().autoIndex });
