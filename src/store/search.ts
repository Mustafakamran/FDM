import { create } from "zustand";

interface SearchState {
  q: string;
  set: (q: string) => void;
}

export const useSearch = create<SearchState>((set) => ({
  q: "",
  set: (q) => set({ q }),
}));
