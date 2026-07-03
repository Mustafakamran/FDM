import { describe, it, expect } from "vitest";
import { viewValidForAccounts, type View } from "./app";

const ids = new Set(["drive_a", "dropbox_b"]);

describe("viewValidForAccounts", () => {
  it("keeps a browse view whose account still exists", () => {
    const v: View = { kind: "browse", accountId: "drive_a", section: "all", path: "Footage" };
    expect(viewValidForAccounts(v, ids)).toBe(true);
  });

  it("drops a browse view whose account was removed", () => {
    const v: View = { kind: "browse", accountId: "drive_gone", section: "all", path: "" };
    expect(viewValidForAccounts(v, ids)).toBe(false);
  });

  it("drops a REVIEW view whose account was removed (the regression this fixes)", () => {
    const v: View = {
      kind: "review",
      accountId: "drive_gone",
      target: { path: "clip.mp4", name: "clip.mp4", fileId: "x", size: 1, ext: ".mp4" },
    };
    expect(viewValidForAccounts(v, ids)).toBe(false);
  });

  it("keeps a review view whose account still exists", () => {
    const v: View = {
      kind: "review",
      accountId: "dropbox_b",
      target: { path: "clip.mp4", name: "clip.mp4", fileId: "x", size: 1, ext: ".mp4" },
    };
    expect(viewValidForAccounts(v, ids)).toBe(true);
  });

  it("always keeps views not bound to an account", () => {
    expect(viewValidForAccounts({ kind: "home" }, ids)).toBe(true);
    expect(viewValidForAccounts({ kind: "accounts" }, ids)).toBe(true);
    expect(viewValidForAccounts({ kind: "downloads", filter: "all" }, ids)).toBe(true);
    expect(viewValidForAccounts({ kind: "uploads", filter: "all" }, ids)).toBe(true);
  });
});
