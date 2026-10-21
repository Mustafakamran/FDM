import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useBrowse, browseKey } from "./browse";
import type { Account } from "../lib/tauri/commands";

const account: Account = { id: "drive_x", provider: "drive", label: "x" };

beforeEach(() => {
  invokeMock.mockReset();
  useBrowse.setState({ listings: {}, loading: {}, errors: {}, sizes: {} });
});

describe("browse store", () => {
  it("caches an ID-native Drive listing (and skips rclone folder sizing)", async () => {
    // Plain Drive browses by id: `ensure` at a folder path calls `drive_list`.
    invokeMock.mockResolvedValue([
      { id: "sub", name: "Sub", isDir: true, size: 0, modTime: "", mimeType: "", parentId: "" },
    ]);

    await useBrowse.getState().ensure(account, "root");
    // Folder size is skipped for plain Drive (id-chain is not an rclone path).
    await useBrowse.getState().computeSize(account, "root/sub");

    const st = useBrowse.getState();
    expect(st.errors[browseKey("drive_x", "root")]).toBeUndefined();
    expect(st.listings[browseKey("drive_x", "root")].map((i) => i.Name)).toEqual(["Sub"]);
    expect(st.sizes[browseKey("drive_x", "root/sub")]).toBe(0);
  });

  it("shows the virtual roots at a Drive account root with no API call", async () => {
    await useBrowse.getState().ensure(account, "");
    const st = useBrowse.getState();
    expect(st.listings[browseKey("drive_x", "")].map((i) => i.Name)).toEqual(["My Drive", "Shared with me"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("records an error when listing fails", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    await useBrowse.getState().ensure(account, "bad");
    expect(useBrowse.getState().errors[browseKey("drive_x", "bad")]).toMatch(/boom/);
  });
});
