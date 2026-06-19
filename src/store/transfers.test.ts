import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useTransfers } from "./transfers";
import type { JobStatus } from "../lib/tauri/commands";

function job(over: Partial<JobStatus>): JobStatus {
  return {
    jobId: 1,
    accountId: "drive_x",
    name: "a.mxf",
    dest: "/dest",
    totalBytes: 1000,
    bytes: 0,
    speed: 0,
    eta: null,
    finished: false,
    success: false,
    cancelled: false,
    error: "",
    ...over,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  useTransfers.setState({ jobs: [], dockOpen: true });
});

afterEach(() => {
  useTransfers.getState().stopPolling();
});

describe("transfers store", () => {
  it("start() launches a download and tracks the returned jobs", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "start_download") return Promise.resolve([job({ jobId: 7 })]);
      if (cmd === "list_jobs") return Promise.resolve([job({ jobId: 7, finished: true, success: true })]);
      return Promise.resolve(undefined);
    });

    await useTransfers.getState().start("drive_x", [{ path: "a.mxf", name: "a.mxf", isDir: false, size: 1000 }], "/dest");

    const jobs = useTransfers.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe(7);
    expect(invokeMock).toHaveBeenCalledWith("start_download", {
      accountId: "drive_x",
      items: [{ path: "a.mxf", name: "a.mxf", isDir: false, size: 1000 }],
      dest: "/dest",
    });
  });

  it("cancel() calls cancel_job then refreshes", async () => {
    useTransfers.setState({ jobs: [job({ jobId: 3 })] });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "cancel_job") return Promise.resolve(undefined);
      if (cmd === "list_jobs") return Promise.resolve([job({ jobId: 3, cancelled: true, finished: true })]);
      return Promise.resolve(undefined);
    });

    await useTransfers.getState().cancel(3);

    expect(invokeMock).toHaveBeenCalledWith("cancel_job", { jobId: 3 });
    expect(useTransfers.getState().jobs[0].cancelled).toBe(true);
  });
});
