import { create } from "zustand";

export type Theme = "dark" | "light";
const KEY = "theme";

function apply(t: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("light", t === "light");
  }
}

function load(): Theme {
  const t = (localStorage.getItem(KEY) as Theme) || "dark";
  const v: Theme = t === "light" ? "light" : "dark";
  apply(v);
  return v;
}

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: load(),
  toggle: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  setTheme: (t) => {
    localStorage.setItem(KEY, t);
    apply(t);
    set({ theme: t });
  },
}));
