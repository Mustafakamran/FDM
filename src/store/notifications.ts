import { create } from "zustand";
import type { Provider } from "../lib/tauri/commands";

export interface FolderNotification {
  id: string;
  accountId: string;
  provider: Provider;
  accountLabel: string;
  folderName: string;
  path: string;
  modTime: string;
  size: number | null; // null = computing/unknown
  uploader: string | null; // null = unknown/unavailable
  at: number;
  read: boolean;
}

interface NotifyState {
  items: FolderNotification[];
  panelOpen: boolean;
  add: (n: FolderNotification) => void;
  update: (id: string, patch: Partial<FolderNotification>) => void;
  togglePanel: (open?: boolean) => void;
  markAllRead: () => void;
  clear: () => void;
}

export const useNotifications = create<NotifyState>((set) => ({
  items: [],
  panelOpen: false,

  add: (n) =>
    set((s) => (s.items.some((i) => i.id === n.id) ? s : { items: [n, ...s.items].slice(0, 200) })),

  update: (id, patch) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),

  togglePanel: (open) =>
    set((s) => {
      const panelOpen = open ?? !s.panelOpen;
      return panelOpen
        ? { panelOpen, items: s.items.map((i) => ({ ...i, read: true })) }
        : { panelOpen };
    }),

  markAllRead: () => set((s) => ({ items: s.items.map((i) => ({ ...i, read: true })) })),

  clear: () => set({ items: [] }),
}));

export const unreadCount = (items: FolderNotification[]) => items.filter((i) => !i.read).length;
