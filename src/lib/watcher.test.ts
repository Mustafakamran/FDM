import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

import { diffNew } from "./watcher";
import type { RcItem } from "./rc/browse";

function dir(name: string): RcItem {
  return { Name: name, Path: name, Size: -1, IsDir: true, ModTime: "", MimeType: "" };
}
function file(name: string): RcItem {
  return { Name: name, Path: name, Size: 1, IsDir: false, ModTime: "", MimeType: "" };
}

describe("diffNew", () => {
  it("returns only new directories, ignoring files and seen dirs", () => {
    const current = [dir("A"), file("clip.mxf"), dir("B"), dir("C")];
    const fresh = diffNew(current, ["A", "C"]);
    expect(fresh.map((d) => d.Name)).toEqual(["B"]);
  });

  it("returns nothing when all dirs are already seen", () => {
    expect(diffNew([dir("A"), file("x")], ["A"])).toEqual([]);
  });
});
