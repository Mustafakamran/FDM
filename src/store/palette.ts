import { create } from "zustand";

interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Cmd/Ctrl+K command palette visibility — see CommandPalette.tsx. */
export const usePalette = create<PaletteState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}));
