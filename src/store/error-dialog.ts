import { create } from "zustand";

/** One error surfaced in the global error dialog. */
export interface AppError {
  /** Short, human title ("Couldn’t open this folder"). */
  title: string;
  /** One-sentence plain explanation of what happened / what to do. */
  message: string;
  /** The raw technical error (rc dump, stack, HTTP body), shown collapsed + copyable. */
  detail?: string;
  /** Optional Retry action; when set the dialog shows a Retry button beside Close. */
  onRetry?: () => void;
}

interface ErrorDialogState {
  current: AppError | null;
  show: (err: AppError) => void;
  close: () => void;
}

/**
 * App-wide error dialog. Anywhere that would otherwise dump a raw error inline
 * can call `useErrorDialog.getState().show({ title, message, detail })` to present
 * it as a clean modal: a friendly message up top, the raw technical detail tucked
 * behind a disclosure and copyable for support.
 */
export const useErrorDialog = create<ErrorDialogState>((set) => ({
  current: null,
  show: (current) => set({ current }),
  close: () => set({ current: null }),
}));

/** Convenience: show an error from a caught value, with a title + friendly message. */
export function showError(title: string, message: string, detail?: unknown, onRetry?: () => void): void {
  const d = detail == null ? undefined : detail instanceof Error ? detail.message : String(detail);
  useErrorDialog.getState().show({ title, message, detail: d, onRetry });
}
