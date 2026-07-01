import { create } from "zustand";
import { loadRaw, saveRaw } from "../lib/persisted";

export type Theme = "dark" | "light";
const THEME_KEY = "theme";
const ACCENT_KEY = "accent";

/**
 * "Mono" is the app's original monochrome accent (near-black in light, near-
 * white in dark — every primary action inherits it). The rest are real
 * colors, applied via a `data-accent` attribute on <html> with matching CSS
 * overrides in index.css (one block per preset per theme, since a color
 * accent needs different lightness in light vs dark to stay readable).
 */
export type Accent = "mono" | "blue" | "purple" | "rose" | "orange" | "teal";
export const ACCENTS: Accent[] = ["mono", "blue", "purple", "rose", "orange", "teal"];

function applyTheme(t: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("light", t === "light");
  }
}

function applyAccent(a: Accent) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-accent", a);
  }
}

function loadTheme(): Theme {
  const t = loadRaw(THEME_KEY, "dark");
  const v: Theme = t === "light" ? "light" : "dark";
  applyTheme(v);
  return v;
}

function loadAccent(): Accent {
  const a = loadRaw(ACCENT_KEY, "mono");
  const v: Accent = (ACCENTS as string[]).includes(a) ? (a as Accent) : "mono";
  applyAccent(v);
  return v;
}

interface ThemeState {
  theme: Theme;
  accent: Accent;
  toggle: () => void;
  setTheme: (t: Theme) => void;
  setAccent: (a: Accent) => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: loadTheme(),
  accent: loadAccent(),
  toggle: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  setTheme: (t) => {
    saveRaw(THEME_KEY, t);
    applyTheme(t);
    set({ theme: t });
  },
  setAccent: (a) => {
    saveRaw(ACCENT_KEY, a);
    applyAccent(a);
    set({ accent: a });
  },
}));
