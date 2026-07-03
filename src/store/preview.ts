import { create } from "zustand";
import type { ReviewTarget } from "./app";

interface PreviewState {
  /** The file currently open in the lightweight preview overlay, or null. */
  current: { accountId: string; target: ReviewTarget } | null;
  open: (accountId: string, target: ReviewTarget) => void;
  close: () => void;
}

/**
 * Lightweight preview overlay — single-click on a video/image opens it here
 * (image shown large / video played inline, no review chrome). Distinct from the
 * full reviewer (right-click → Review), which lives in its own view. See
 * PreviewOverlay.tsx.
 */
export const usePreview = create<PreviewState>((set) => ({
  current: null,
  open: (accountId, target) => set({ current: { accountId, target } }),
  close: () => set({ current: null }),
}));
