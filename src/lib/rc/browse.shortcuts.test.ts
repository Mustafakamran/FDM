import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ShortcutTarget } from "../tauri/commands";

// Mock the Tauri command so the resolver runs without a backend.
vi.mock("../tauri/commands", () => ({ resolveShortcut: vi.fn() }));
import { resolveShortcut } from "../tauri/commands";
import { resolveDriveShortcuts, type RcItem } from "./browse";

const SHORTCUT = "application/vnd.google-apps.shortcut";
const mocked = vi.mocked(resolveShortcut);

function item(over: Partial<RcItem> = {}): RcItem {
  return { Name: "x", Path: "p", Size: 2200, IsDir: false, ModTime: "", MimeType: SHORTCUT, ID: "sc1", ...over };
}
const target = (over: Partial<ShortcutTarget>): ShortcutTarget => ({
  targetId: "tgt", targetMime: "application/vnd.google-apps.folder", isDir: true, targetPath: "Real/Folder", ...over,
});

describe("resolveDriveShortcuts", () => {
  beforeEach(() => mocked.mockReset());

  it("rewrites a folder-shortcut to its target folder (opens/downloads by target id+path)", async () => {
    mocked.mockResolvedValue(target({ isDir: true, targetId: "folder99", targetPath: "Clients/Kolo" }));
    const [out] = await resolveDriveShortcuts([item({ Name: "Kolo", Path: "Kolo" })], () => "drive_1");
    expect(mocked).toHaveBeenCalledWith("drive_1", "sc1");
    expect(out.IsDir).toBe(true);
    expect(out.ID).toBe("folder99");
    expect(out.Path).toBe("Clients/Kolo");
    expect(out.MimeType).toBe("application/vnd.google-apps.folder");
  });

  it("rewrites a file-shortcut to its target file, keeping IsDir false", async () => {
    mocked.mockResolvedValue(target({ isDir: false, targetId: "file42", targetMime: "video/mp4", targetPath: "" }));
    const [out] = await resolveDriveShortcuts([item({ Name: "clip.mp4" })], () => "drive_1");
    expect(out.IsDir).toBe(false);
    expect(out.ID).toBe("file42");
    expect(out.MimeType).toBe("video/mp4");
  });

  it("preserves extra fields (e.g. AccountId on a global search hit)", async () => {
    mocked.mockResolvedValue(target({ targetId: "f1" }));
    type Hit = RcItem & { AccountId?: string };
    const hit: Hit = { ...item(), AccountId: "drive_1" };
    const [out] = await resolveDriveShortcuts<Hit>([hit], (h) => h.AccountId);
    expect(out.AccountId).toBe("drive_1");
    expect(out.ID).toBe("f1");
  });

  it("leaves non-shortcut rows untouched and never resolves them", async () => {
    const rows = [item({ MimeType: "video/mp4", IsDir: false, ID: "real" })];
    const out = await resolveDriveShortcuts(rows, () => "drive_1");
    expect(out[0]).toEqual(rows[0]);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("skips items whose accountIdOf is undefined (unknown/non-Drive account)", async () => {
    const out = await resolveDriveShortcuts([item()], () => undefined);
    expect(mocked).not.toHaveBeenCalled();
    expect(out[0].MimeType).toBe(SHORTCUT); // unchanged
  });

  it("resolves only the shortcut rows, passing through real files/folders in a mixed list", async () => {
    mocked.mockResolvedValue(target({ isDir: true, targetId: "ok1", targetPath: "Real" }));
    const realFolder = item({ Name: "RealFolder", ID: "rf", IsDir: true, MimeType: "application/vnd.google-apps.folder" });
    const sc = item({ Name: "Shortcut", ID: "sc" });
    const out = await resolveDriveShortcuts([realFolder, sc], () => "drive_1");
    expect(mocked).toHaveBeenCalledTimes(1); // only the shortcut
    expect(mocked).toHaveBeenCalledWith("drive_1", "sc");
    expect(out[0]).toEqual(realFolder); // untouched
    expect(out[1].ID).toBe("ok1"); // resolved
  });
});
