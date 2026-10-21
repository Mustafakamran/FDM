import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { buildFs, listFolder, DRIVE_MY, DRIVE_SHARED, type RcItem } from "./browse";
import type { Account, DriveRow } from "../tauri/commands";

const drive: Account = { id: "drive_x", provider: "drive", label: "x" };
const dropbox: Account = { id: "dropbox_y", provider: "dropbox", label: "y" };

function item(p: Partial<RcItem>): RcItem {
  return { Name: "", Path: "", Size: 0, IsDir: false, ModTime: "", MimeType: "", ...p };
}
function row(p: Partial<DriveRow>): DriveRow {
  return { id: "", name: "", isDir: false, size: 0, modTime: "", mimeType: "", parentId: "", isShortcut: false, ...p };
}

describe("buildFs", () => {
  it("adds shared_with_me for drive, plain for dropbox", () => {
    expect(buildFs(drive)).toBe("drive_x,shared_with_me=true:");
    expect(buildFs(dropbox)).toBe("dropbox_y:");
  });
});

describe("listFolder", () => {
  beforeEach(() => invokeMock.mockReset());

  it("sorts dirs first then alphabetical, and tolerates missing list (non-Drive)", async () => {
    invokeMock.mockResolvedValue({
      list: [
        item({ Name: "zeta.mxf", Path: "sub/zeta.mxf" }),
        item({ Name: "Beta", Path: "sub/Beta", IsDir: true }),
        item({ Name: "alpha.mxf", Path: "sub/alpha.mxf" }),
        item({ Name: "Alpha", Path: "sub/Alpha", IsDir: true }),
      ],
    });
    const out = await listFolder(dropbox, "sub");
    expect(out.map((i) => i.Name)).toEqual(["Alpha", "Beta", "alpha.mxf", "zeta.mxf"]);

    invokeMock.mockResolvedValue({});
    expect(await listFolder(dropbox, "sub")).toEqual([]);
  });

  it("shows the two virtual roots (My Drive, Shared with me) at a plain Drive root", async () => {
    const out = await listFolder(drive, "");
    expect(out.map((i) => i.Name)).toEqual(["My Drive", "Shared with me"]);
    expect(out[0].Path).toBe(DRIVE_MY);
    expect(out[0].LinkFolderId).toBe(DRIVE_MY); // folders open/download by id
    expect(out[1].Path).toBe(DRIVE_SHARED);
    expect(invokeMock).not.toHaveBeenCalled(); // root is synthetic, no API hit
  });

  it("lists a Drive folder by ID via drive_list, id-chained paths, dirs first", async () => {
    invokeMock.mockResolvedValue([
      row({ id: "f2", name: "Renders", isDir: true }),
      row({ id: "a1", name: "a.mxf", size: 10 }),
      row({ id: "f1", name: "Audio", isDir: true }),
    ]);
    const out = await listFolder(drive, "root/f0");
    expect(invokeMock).toHaveBeenCalledWith("drive_list", { accountId: "drive_x", folderId: "f0" });
    expect(out.map((i) => i.Name)).toEqual(["Audio", "Renders", "a.mxf"]);
    // Each row's Path appends its own id so navigation stays id-addressed.
    expect(out.find((i) => i.Name === "Renders")!.Path).toBe("root/f0/f2");
    expect(out.find((i) => i.Name === "Renders")!.LinkFolderId).toBe("f2");
    expect(out.find((i) => i.Name === "a.mxf")!.LinkFolderId).toBeUndefined();
  });

  it("a drive-link account stays rclone name-path (no ID-native browse)", async () => {
    const link: Account = { id: "drivelink_x", provider: "drive", label: "l" };
    invokeMock.mockResolvedValue({ list: [item({ Name: "Inside", Path: "Inside", IsDir: true, ID: "i1" })] });
    const out = await listFolder(link, "");
    expect(out.map((i) => i.Name)).toEqual(["Inside"]);
    expect(out.find((i) => i.Name === "My Drive")).toBeUndefined();
  });
});
