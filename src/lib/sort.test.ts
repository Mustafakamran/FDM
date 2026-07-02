import { describe, it, expect } from "vitest";
import { sortItems, DEFAULT_SORT, type SortResolvers, type SortState } from "./sort";
import type { RcItem } from "./rc/browse";

function f(name: string, size: number, mod: string): RcItem {
  return { Name: name, Path: name, Size: size, IsDir: false, ModTime: mod, MimeType: "" };
}
function d(name: string): RcItem {
  return { Name: name, Path: name, Size: -1, IsDir: true, ModTime: "", MimeType: "" };
}

const items: RcItem[] = [
  d("Zebra"),
  d("alpha"),
  f("b.mp4", 300, "2026-03-01T00:00:00Z"),
  f("a.txt", 100, "2026-01-01T00:00:00Z"),
  f("c.mp4", 200, "2026-02-01T00:00:00Z"),
];

// Resolvers mirroring how BrowsePane reads folder aggregates: folders report a
// recursive size / latest date pulled from a fake index agg.
const agg: Record<string, { size: number; latest: string }> = {
  Zebra: { size: 5000, latest: "2026-05-01T00:00:00Z" },
  alpha: { size: 50, latest: "2025-12-01T00:00:00Z" },
};
const resolvers: SortResolvers = {
  sizeOf: (i) => (i.IsDir ? agg[i.Path]?.size ?? 0 : Math.max(0, i.Size)),
  dateOf: (i) => (i.IsDir ? agg[i.Path]?.latest ?? "" : i.ModTime),
};

function names(s: SortState) {
  return sortItems(items, s, resolvers).map((i) => i.Name);
}

describe("sortItems", () => {
  it("default: folders first, then name ascending (case-insensitive)", () => {
    expect(names(DEFAULT_SORT)).toEqual(["alpha", "Zebra", "a.txt", "b.mp4", "c.mp4"]);
  });

  it("name descending flips order but keeps folders grouped first", () => {
    expect(names({ field: "name", dir: "desc", foldersFirst: true })).toEqual([
      "Zebra",
      "alpha",
      "c.mp4",
      "b.mp4",
      "a.txt",
    ]);
  });

  it("size ascending: folders sort by their aggregate value, NOT pinned first", () => {
    // foldersFirst is ignored for value sorts → a true size order across all items.
    expect(names({ field: "size", dir: "asc", foldersFirst: true })).toEqual([
      "alpha", // 50 (folder)
      "a.txt", // 100
      "c.mp4", // 200
      "b.mp4", // 300
      "Zebra", // 5000 (folder)
    ]);
  });

  it("size descending: largest overall first (folder included by size)", () => {
    expect(names({ field: "size", dir: "desc", foldersFirst: true })).toEqual([
      "Zebra", // 5000 (folder)
      "b.mp4", // 300
      "c.mp4", // 200
      "a.txt", // 100
      "alpha", // 50 (folder)
    ]);
  });

  it("date modified ascending orders by mod time across folders + files", () => {
    expect(names({ field: "modified", dir: "asc", foldersFirst: true })).toEqual([
      "alpha", // 2025-12 (folder)
      "a.txt", // 2026-01
      "c.mp4", // 2026-02
      "b.mp4", // 2026-03
      "Zebra", // 2026-05 (folder)
    ]);
  });

  it("foldersFirst=false lets folders interleave with files by the field", () => {
    // size ascending across everything: alpha(50) a.txt(100) c.mp4(200) b.mp4(300) Zebra(5000)
    expect(names({ field: "size", dir: "asc", foldersFirst: false })).toEqual([
      "alpha",
      "a.txt",
      "c.mp4",
      "b.mp4",
      "Zebra",
    ]);
  });

  it("does not mutate the input array", () => {
    const before = items.map((i) => i.Name);
    sortItems(items, { field: "size", dir: "desc", foldersFirst: false }, resolvers);
    expect(items.map((i) => i.Name)).toEqual(before);
  });

  it("name ascending tiebreaks equal sizes deterministically", () => {
    const dupes: RcItem[] = [f("y.bin", 10, ""), f("x.bin", 10, ""), f("z.bin", 10, "")];
    const out = sortItems(dupes, { field: "size", dir: "asc", foldersFirst: false }).map((i) => i.Name);
    expect(out).toEqual(["x.bin", "y.bin", "z.bin"]);
  });

  it("case-only-different names hold a stable, deterministic order", () => {
    // Path is the final tiebreaker, so 'File'/'file' never flip arbitrarily.
    const same: RcItem[] = [
      { Name: "file", Path: "b/file", Size: 1, IsDir: false, ModTime: "", MimeType: "" },
      { Name: "File", Path: "a/File", Size: 1, IsDir: false, ModTime: "", MimeType: "" },
    ];
    const asc = sortItems(same, { field: "name", dir: "asc", foldersFirst: false }).map((i) => i.Path);
    expect(asc).toEqual(["a/File", "b/file"]);
  });

  it("size sort parks still-computing folders at the bottom regardless of direction", () => {
    // 'big' has no known size yet (sizeKnown=false) — it must sit last in BOTH
    // directions rather than being treated as 0 and jumping to the top.
    const rs: SortResolvers = {
      sizeOf: (i) => (i.IsDir ? agg[i.Path]?.size ?? 0 : Math.max(0, i.Size)),
      dateOf: (i) => i.ModTime,
      sizeKnown: (i) => i.Name !== "big",
    };
    const list: RcItem[] = [d("big"), f("s.mp4", 100, ""), f("m.mp4", 400, "")];
    const asc = sortItems(list, { field: "size", dir: "asc", foldersFirst: false }, rs).map((i) => i.Name);
    const desc = sortItems(list, { field: "size", dir: "desc", foldersFirst: false }, rs).map((i) => i.Name);
    expect(asc).toEqual(["s.mp4", "m.mp4", "big"]);
    expect(desc).toEqual(["m.mp4", "s.mp4", "big"]);
  });

  it("date sort compares timestamps, not raw strings (mixed offsets)", () => {
    // 09:00Z is EARLIER than 05:00-08:00 (=13:00Z). A raw string compare would
    // order them wrong; epoch parsing gets it right.
    const list: RcItem[] = [
      f("later.mp4", 1, "2026-01-01T05:00:00-08:00"),
      f("earlier.mp4", 1, "2026-01-01T09:00:00Z"),
    ];
    const asc = sortItems(list, { field: "modified", dir: "asc", foldersFirst: false }).map((i) => i.Name);
    expect(asc).toEqual(["earlier.mp4", "later.mp4"]);
  });
});
