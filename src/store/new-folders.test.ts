import { describe, it, expect } from "vitest";
import { pickNewFolders } from "./new-folders";
import type { RcItem } from "../lib/rc/browse";

// A months-old content date — a newly *shared* folder keeps its original date,
// so detection must NOT gate on it.
const old = "2026-01-01T00:00:00Z";

function dir(path: string, modTime = old): RcItem {
  return { Name: path, Path: path, Size: -1, IsDir: true, ModTime: modTime, MimeType: "" };
}
function file(path: string): RcItem {
  return { Name: path, Path: path, Size: 10, IsDir: false, ModTime: old, MimeType: "" };
}
const none = () => false;

describe("pickNewFolders", () => {
  it("flags a root folder not in the baseline", () => {
    const out = pickNewFolders([dir("Client A")], new Set(), none);
    expect(out.map((i) => i.Path)).toEqual(["Client A"]);
  });

  it("ignores folders already in the baseline (seen before)", () => {
    const out = pickNewFolders([dir("Client A"), dir("Client B")], new Set(["Client A"]), none);
    expect(out.map((i) => i.Path)).toEqual(["Client B"]);
  });

  it("flags a newly-shared folder regardless of its (old) modified-time", () => {
    // The core fix: a client sharing a months-old shoot must still surface.
    const out = pickNewFolders([dir("Old Shoot", old)], new Set(), none);
    expect(out.map((i) => i.Path)).toEqual(["Old Shoot"]);
  });

  it("ignores folders that have already been downloaded", () => {
    const downloaded = (p: string) => p === "Client A";
    expect(pickNewFolders([dir("Client A")], new Set(), downloaded)).toEqual([]);
  });

  it("ignores files — only root FOLDERS count", () => {
    const out = pickNewFolders([file("render.mp4"), dir("Client A")], new Set(), none);
    expect(out.map((i) => i.Path)).toEqual(["Client A"]);
  });

  it("includes a folder with no modified-time (share dates are unreliable)", () => {
    const out = pickNewFolders([dir("No Date", "")], new Set(), none);
    expect(out.map((i) => i.Path)).toEqual(["No Date"]);
  });
});
