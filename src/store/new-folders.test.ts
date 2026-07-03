import { describe, it, expect } from "vitest";
import { pickNewFolders } from "./new-folders";
import type { RcItem } from "../lib/rc/browse";

const NOW = Date.parse("2026-07-03T00:00:00Z");
const recent = "2026-07-01T00:00:00Z"; // 2 days ago
const old = "2026-01-01T00:00:00Z"; // ~6 months ago

function dir(path: string, modTime: string): RcItem {
  return { Name: path, Path: path, Size: -1, IsDir: true, ModTime: modTime, MimeType: "" };
}
function file(path: string): RcItem {
  return { Name: path, Path: path, Size: 10, IsDir: false, ModTime: recent, MimeType: "" };
}
const none = () => false;

describe("pickNewFolders", () => {
  it("flags a recent root folder not in the baseline", () => {
    const items = [dir("Client A", recent)];
    const out = pickNewFolders(items, new Set(), none, NOW);
    expect(out.map((i) => i.Path)).toEqual(["Client A"]);
  });

  it("ignores folders already in the baseline (seen before)", () => {
    const items = [dir("Client A", recent), dir("Client B", recent)];
    const out = pickNewFolders(items, new Set(["Client A"]), none, NOW);
    expect(out.map((i) => i.Path)).toEqual(["Client B"]);
  });

  it("ignores folders modified outside the date window", () => {
    const items = [dir("Old Project", old)];
    expect(pickNewFolders(items, new Set(), none, NOW)).toEqual([]);
  });

  it("ignores folders that have already been downloaded", () => {
    const items = [dir("Client A", recent)];
    const downloaded = (p: string) => p === "Client A";
    expect(pickNewFolders(items, new Set(), downloaded, NOW)).toEqual([]);
  });

  it("ignores files — only root FOLDERS count", () => {
    const items = [file("render.mp4"), dir("Client A", recent)];
    const out = pickNewFolders(items, new Set(), none, NOW);
    expect(out.map((i) => i.Path)).toEqual(["Client A"]);
  });

  it("treats a folder with no modified-time as not-new (no false positives)", () => {
    const items = [dir("No Date", "")];
    expect(pickNewFolders(items, new Set(), none, NOW)).toEqual([]);
  });
});
