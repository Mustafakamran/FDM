import type { ReactNode } from "react";
import { create } from "zustand";

export type ToastType = "success" | "error" | "info";
export interface Toast {
  id: number;
  message: ReactNode;
  type: ToastType;
  /** True during the exit animation, just before the toast is removed. */
  leaving?: boolean;
}

let seq = 0;

interface ToastState {
  toasts: Toast[];
  /** Returns the id so callers can dismiss a long-lived toast early. */
  push: (message: ReactNode, type?: ToastType, ttl?: number) => number;
  dismiss: (id: number) => void;
}

const DEFAULT_TTL = 3200;
const EXIT_MS = 200; // must match the .animate-toast-out duration

export const useToasts = create<ToastState>((set, get) => {
  // Two-phase removal: flag `leaving` (drives the exit animation), then drop the
  // toast after the animation finishes. Idempotent — a double dismiss is harmless.
  const beginDismiss = (id: number) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), EXIT_MS);
  };
  return {
    toasts: [],
    push: (message, type = "success", ttl = DEFAULT_TTL) => {
      // Dedup identical string toasts still on screen (e.g. a background event
      // that fires more than once) — return the existing id instead of stacking.
      if (typeof message === "string") {
        const dup = get().toasts.find((t) => !t.leaving && t.type === type && t.message === message);
        if (dup) return dup.id;
      }
      const id = ++seq;
      set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
      if (ttl > 0) setTimeout(() => beginDismiss(id), ttl);
      return id;
    },
    dismiss: (id) => beginDismiss(id),
  };
});
