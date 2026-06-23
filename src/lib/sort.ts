import type { RcItem } from "./rc/browse";
import { fileType } from "./file-types";

export type SortField = "name" | "size" | "modified" | "type";
export type SortDir = "asc" | "desc";

export interface SortState {
  field: SortField;
  dir: SortDir;
  /** Keep folders grouped above files regardless of the field. Default behavior. */
  foldersFirst: boolean;
}

export const DEFAULT_SORT: SortState = { field: "name", dir: "asc", foldersFirst: true };

/**
 * Resolvers let the comparator stay pure while still honoring the index
 * aggregate (folders report their recursive size / newest mod time). The
 * caller supplies how to read a size and a date from any entry; for files
 * these fall back to the entry's own Size / ModTime.
 */
export interface SortResolvers {
  sizeOf: (i: RcItem) => number;
  dateOf: (i: RcItem) => string;
}

const defaultResolvers: SortResolvers = {
  sizeOf: (i) => (i.IsDir ? 0 : Math.max(0, i.Size)),
  dateOf: (i) => (i.IsDir ? "" : i.ModTime),
};

/** Compare two entries by a single field (ascending). Stable and side-effect free. */
function compareByField(a: RcItem, b: RcItem, field: SortField, r: SortResolvers): number {
  switch (field) {
    case "name":
      return a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
    case "size":
      return r.sizeOf(a) - r.sizeOf(b);
    case "modified": {
      const da = r.dateOf(a);
      const db = r.dateOf(b);
      return da < db ? -1 : da > db ? 1 : 0;
    }
    case "type":
      return fileType(a.Name, a.IsDir).label.localeCompare(fileType(b.Name, b.IsDir).label);
  }
}

/**
 * Pure sort: returns a new array sorted by `field`/`dir`. When
 * `state.foldersFirst` is true, folders are grouped ahead of files and the
 * field/direction only orders within each group. Name is always the tiebreaker
 * so ordering is deterministic.
 */
export function sortItems(
  items: RcItem[],
  state: SortState,
  resolvers: SortResolvers = defaultResolvers,
): RcItem[] {
  const mult = state.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (state.foldersFirst && a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
    let r = compareByField(a, b, state.field, resolvers) * mult;
    if (r === 0 && state.field !== "name") {
      // Deterministic tiebreaker — keep equal sizes/dates in a stable name order.
      r = a.Name.toLowerCase().localeCompare(b.Name.toLowerCase());
    }
    return r;
  });
}
