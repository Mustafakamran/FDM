import { create } from "zustand";

export interface ReviewComment {
  id: string;
  /** Video timestamp in seconds. */
  time: number;
  text: string;
  createdAt: number;
}
export type ReviewStatus = "in_progress" | "reviewed";
export interface FileReview {
  status: ReviewStatus;
  comments: ReviewComment[];
}

const KEY = "reviews_v1";
export const fileKey = (accountId: string, path: string) => `${accountId}|${path}`;
const EMPTY: FileReview = { status: "in_progress", comments: [] };

function load(): Record<string, FileReview> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}
function persist(data: Record<string, FileReview>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* quota — comments are small (no images stored), so this is unlikely */
  }
}

let seq = 0;
const cid = () => `c${Date.now()}_${++seq}`;

interface ReviewState {
  byFile: Record<string, FileReview>;
  addComment: (accountId: string, path: string, time: number, text: string) => void;
  removeComment: (accountId: string, path: string, id: string) => void;
  setStatus: (accountId: string, path: string, status: ReviewStatus) => void;
}

export const useReview = create<ReviewState>((set) => ({
  byFile: load(),

  addComment: (accountId, path, time, text) =>
    set((s) => {
      const k = fileKey(accountId, path);
      const cur = s.byFile[k] ?? EMPTY;
      const comments = [...cur.comments, { id: cid(), time, text, createdAt: Date.now() }].sort(
        (a, b) => a.time - b.time,
      );
      const next = { ...s.byFile, [k]: { status: cur.status, comments } };
      persist(next);
      return { byFile: next };
    }),

  removeComment: (accountId, path, id) =>
    set((s) => {
      const k = fileKey(accountId, path);
      const cur = s.byFile[k];
      if (!cur) return s;
      const next = { ...s.byFile, [k]: { ...cur, comments: cur.comments.filter((c) => c.id !== id) } };
      persist(next);
      return { byFile: next };
    }),

  setStatus: (accountId, path, status) =>
    set((s) => {
      const k = fileKey(accountId, path);
      const cur = s.byFile[k] ?? EMPTY;
      const next = { ...s.byFile, [k]: { status, comments: cur.comments } };
      persist(next);
      return { byFile: next };
    }),
}));
