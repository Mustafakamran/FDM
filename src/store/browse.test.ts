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
  it("caches the listing and computes folder sizes", async () => {
    invokeMock.mockImplementation((_cmd: string, args?: { endpoint?: string }) => {
      if (args?.endpoint === "operations/list")
        return Promise.resolve({
          list: [{ Name: "Sub", Path: "Sub", Size: -1, IsDir: true, ModTime: "", MimeType: "" }],
        });
      if (args?.endpoint === "operations/size") return Promise.resolve({ bytes: 5000, count: 3 });
      return Promise.resolve({});
    });

    await useBrowse.getState().ensure(account, "");
    await new Promise((r) => setTimeout(r, 30)); // let the fired computeSize settle

    const st = useBrowse.getState();
    expect(st.errors[browseKey("drive_x", "")]).toBeUndefined();
    expect(st.listings[browseKey("drive_x", "")]).toHaveLength(1);
    expect(st.sizes[browseKey("drive_x", "Sub")]).toBe(5000);
  });

  it("records an error when listing fails", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    await useBrowse.getState().ensure(account, "bad");
    expect(useBrowse.getState().errors[browseKey("drive_x", "bad")]).toMatch(/boom/);
  });
});
