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
 *
 * `sizeKnown` lets the caller mark a folder's size as not-yet-computed so it
 * can be parked at the bottom of a size sort (stable) instead of counted as 0
 * — otherwise folders visibly jump to the top and shuffle down as their sizes
 * stream in. Defaults to "always known" (files always are).
 */
export interface SortResolvers {
  sizeOf: (i: RcItem) => number;
  dateOf: (i: RcItem) => string;
  sizeKnown?: (i: RcItem) => boolean;
}

const defaultResolvers: SortResolvers = {
  sizeOf: (i) => (i.IsDir ? 0 : Math.max(0, i.Size)),
  dateOf: (i) => (i.IsDir ? "" : i.ModTime),
};

/** Decorated sort key: computed ONCE per item (Schwartzian transform) so the
 *  O(n log n) comparator never re-parses a date, re-lowercases a name, or
 *  re-derives a file type. */
interface SortKey {
  item: RcItem;
  isDir: boolean;
  nameKey: string;
  sizeVal: number | null; // null = size not yet known
  dateVal: number; // epoch ms; -Infinity when absent/unparseable
  typeLabel: string;
  path: string;
}

/** Numeric compare that is safe for ±Infinity (subtraction of two ∞ is NaN). */
function num(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Pure sort: returns a new array sorted by `field`/`dir`. When
 * `state.foldersFirst` is true (name sort only), folders are grouped ahead of
 * files. Every field falls back to a deterministic tiebreaker (case-insensitive
 * name, then full path), so ordering is fully stable and never depends on the
 * engine's sort stability or on which case-variant of a name came first.
 */
export function sortItems(
  items: RcItem[],
  state: SortState,
  resolvers: SortResolvers = defaultResolvers,
): RcItem[] {
  const mult = state.dir === "asc" ? 1 : -1;
  // Folders-first grouping applies only to the NAME sort (the conventional
  // "folders above files alphabetically"). For Size/Date/Type the user wants a
  // TRUE value order — a 16 GB video must outrank a 2 GB folder — so folders are
  // sorted by their own aggregate value, not pinned to the top.
  const groupFolders = state.foldersFirst && state.field === "name";
  const sizeKnown = resolvers.sizeKnown ?? (() => true);

  const keys: SortKey[] = items.map((item) => {
    const dateStr = resolvers.dateOf(item);
    const t = dateStr ? Date.parse(dateStr) : NaN;
    return {
      item,
      isDir: item.IsDir,
      nameKey: item.Name.toLowerCase(),
      sizeVal: sizeKnown(item) ? resolvers.sizeOf(item) : null,
      dateVal: Number.isNaN(t) ? -Infinity : t,
      typeLabel: fileType(item.Name, item.IsDir).label,
      path: item.Path,
    };
  });

  keys.sort((a, b) => {
    if (groupFolders && a.isDir !== b.isDir) return a.isDir ? -1 : 1;

    let r = 0;
    switch (state.field) {
      case "name":
        r = a.nameKey.localeCompare(b.nameKey) * mult;
        break;
      case "type":
        r = a.typeLabel.localeCompare(b.typeLabel) * mult;
        break;
      case "modified":
        r = num(a.dateVal, b.dateVal) * mult;
        break;
      case "size":
        // Unknown sizes always sort LAST, independent of direction, so a folder
        // whose size is still being computed sits stably at the bottom and makes
        // exactly one move (into place) when its value arrives — instead of being
        // treated as 0, pinned to the top, then shuffling down.
        if (a.sizeVal === null && b.sizeVal === null) r = 0;
        else if (a.sizeVal === null) return 1;
        else if (b.sizeVal === null) return -1;
        else r = num(a.sizeVal, b.sizeVal) * mult;
        break;
    }
    if (r !== 0) return r;

    // Deterministic final tiebreakers (direction-independent).
    const n = a.nameKey.localeCompare(b.nameKey);
    if (n !== 0) return n;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return keys.map((k) => k.item);
}
