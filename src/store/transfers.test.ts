import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useTransfers, jobsEqual, inflightEqual, needsPolling, type QueueItem } from "./transfers";
import { laneOf } from "../lib/lane";
import type { JobStatus, DownloadItem } from "../lib/tauri/commands";

function item(name: string): DownloadItem {
  return { path: name, name, isDir: false, size: 1000 };
}
function job(over: Partial<JobStatus>): JobStatus {
  return {
    jobId: 1, accountId: "drive_x", name: "a", dest: "/dest", totalBytes: 1000, bytes: 0,
    speed: 0, eta: null, finished: false, success: false, cancelled: false, error: "", kind: "download", ...over,
  };
}

let nextJobId = 1;
let listReturns: JobStatus[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  nextJobId = 1;
  listReturns = [];
  useTransfers.setState({ jobs: [], uploads: [], queue: [], inflight: [], concurrency: 1, secondaryConcurrency: 3, dockOpen: true });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "start_download") return Promise.resolve([job({ jobId: nextJobId++ })]);
    if (cmd === "list_jobs") return Promise.resolve(listReturns);
    return Promise.resolve(undefined);
  });
});

afterEach(() => useTransfers.getState().stopPolling());

describe("transfers queue", () => {
  it("starts one at a time at concurrency 1, leaving the rest queued", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a"), item("b")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().jobs).toHaveLength(1));
    expect(useTransfers.getState().queue).toHaveLength(1); // "b" still waiting
  });

  it("starts the next queued item when a slot frees", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a"), item("b")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().jobs).toHaveLength(1));

    // First job completes; a refresh frees the slot and pump starts "b".
    listReturns = [job({ jobId: 1, finished: true, success: true })];
    await useTransfers.getState().refresh();
    await vi.waitFor(() => expect(useTransfers.getState().jobs.length).toBe(2));
    expect(useTransfers.getState().queue).toHaveLength(0);
  });

  it("persists queue + in-flight to localStorage so a restart can resume", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a"), item("b")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().jobs).toHaveLength(1));
    // "a" is running (in-flight), "b" still queued — both on disk.
    expect(JSON.parse(localStorage.getItem("download_inflight_v1")!)).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("download_queue_v1")!)).toHaveLength(1);
  });

  it("removes a queued item before it starts", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a"), item("b")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().queue).toHaveLength(1));
    const qid = useTransfers.getState().queue[0].id;
    useTransfers.getState().removeQueued(qid);
    expect(useTransfers.getState().queue).toHaveLength(0);
  });
});

// ── Pure helpers (no-op short-circuit + polling decision) ────────────────────

function qItem(over: Partial<QueueItem> & { accountId: string }): QueueItem {
  return {
    id: over.id ?? `q_${over.accountId}`,
    item: item(over.item?.name ?? over.accountId),
    dest: "/dest",
    ...over,
    lane: laneOf(over.accountId),
  };
}
function inflightItem(accountId: string, jobId: number, bytes = 0): QueueItem & { jobId: number; bytes: number } {
  return { ...qItem({ accountId, id: `inf_${jobId}` }), jobId, bytes };
}

describe("jobsEqual", () => {
  it("is true for identical job data", () => {
    expect(jobsEqual([job({ jobId: 1, bytes: 500 })], [job({ jobId: 1, bytes: 500 })])).toBe(true);
  });
  it("is false when a UI-driving field differs", () => {
    expect(jobsEqual([job({ jobId: 1, bytes: 500 })], [job({ jobId: 1, bytes: 600 })])).toBe(false);
    expect(jobsEqual([job({ jobId: 1, speed: 0 })], [job({ jobId: 1, speed: 10 })])).toBe(false);
    expect(jobsEqual([job({ jobId: 1, finished: false })], [job({ jobId: 1, finished: true })])).toBe(false);
    expect(jobsEqual([job({ jobId: 1, error: "" })], [job({ jobId: 1, error: "boom" })])).toBe(false);
  });
  it("is false when lengths differ", () => {
    expect(jobsEqual([job({ jobId: 1 })], [])).toBe(false);
  });
});

describe("inflightEqual", () => {
  it("is true for identical jobId + bytes", () => {
    expect(inflightEqual([inflightItem("drive_x", 1, 100)], [inflightItem("drive_x", 1, 100)])).toBe(true);
  });
  it("is false when bytes or membership change", () => {
    expect(inflightEqual([inflightItem("drive_x", 1, 100)], [inflightItem("drive_x", 1, 200)])).toBe(false);
    expect(inflightEqual([inflightItem("drive_x", 1, 100)], [])).toBe(false);
  });
});

describe("needsPolling", () => {
  it("is true while a job is in flight", () => {
    expect(needsPolling([], [inflightItem("drive_x", 1)])).toBe(true);
  });
  it("is true for a startable (non-paused, non-autoPaused) queued item", () => {
    expect(needsPolling([qItem({ accountId: "drive_x" })], [])).toBe(true);
  });
  it("is false when the only queued item is user-paused", () => {
    expect(needsPolling([qItem({ accountId: "drive_x", paused: true })], [])).toBe(false);
  });
  it("is false when the only queued item is auto-paused (resumes via pump, not the poll loop)", () => {
    expect(needsPolling([qItem({ accountId: "http", autoPaused: true })], [])).toBe(false);
  });
  it("is false when truly idle", () => {
    expect(needsPolling([], [])).toBe(false);
  });
});

describe("uploads", () => {
  it("splits upload jobs out of the shared poll (never into the downloads list)", async () => {
    listReturns = [
      job({ jobId: 9101, kind: "download", bytes: 10 }),
      job({ jobId: 9102, kind: "upload", name: "render.mp4", bytes: 500 }),
    ];
    await useTransfers.getState().refresh();
    expect(useTransfers.getState().jobs.map((j) => j.jobId)).toEqual([9101]);
    expect(useTransfers.getState().uploads.map((u) => u.jobId)).toEqual([9102]);
  });

  it("keeps completed uploads (for the Uploads screen) until explicitly dismissed", async () => {
    listReturns = [
      job({ jobId: 9201, kind: "upload", name: "ok.mp4", finished: true, success: true }),
      job({ jobId: 9202, kind: "upload", name: "bad.mp4", finished: true, success: false, error: "quota" }),
    ];
    await useTransfers.getState().refresh();
    // Both a completed success and a failure stay listed (mirrors download history).
    expect(useTransfers.getState().uploads.map((u) => u.jobId)).toEqual([9201, 9202]);

    useTransfers.getState().dismissUpload(9201);
    useTransfers.getState().dismissUpload(9202);
    expect(useTransfers.getState().uploads).toHaveLength(0);
    // Dismissed ids stay gone on later ticks even while still in the poll.
    await useTransfers.getState().refresh();
    expect(useTransfers.getState().uploads).toHaveLength(0);
  });

  it("never records an upload into download history", async () => {
    const { useHistory } = await import("./history");
    const before = useHistory.getState().items.length;
    listReturns = [job({ jobId: 9301, kind: "upload", name: "r.mp4", finished: true, success: true })];
    await useTransfers.getState().refresh();
    expect(useHistory.getState().items.length).toBe(before);
  });
});

describe("refresh no-op short-circuit", () => {
  it("a tick with identical job data performs no set() and no localStorage write", async () => {
    // One running job whose bytes don't move between ticks.
    useTransfers.getState().enqueue("drive_x", [item("a")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    const jobId = useTransfers.getState().inflight[0].jobId;
    // Steady-state: list_jobs returns the same in-flight job every tick.
    listReturns = [job({ jobId, bytes: 250, totalBytes: 1000 })];
    await useTransfers.getState().refresh(); // first observation — state updates

    const jobsBefore = useTransfers.getState().jobs;
    const inflightBefore = useTransfers.getState().inflight;
    const inflightLs = localStorage.getItem("download_inflight_v1");
    const setSpy = vi.spyOn(localStorage, "setItem");

    await useTransfers.getState().refresh(); // identical data — must short-circuit

    // No new object identities: the set() was skipped, so references are stable.
    expect(useTransfers.getState().jobs).toBe(jobsBefore);
    expect(useTransfers.getState().inflight).toBe(inflightBefore);
    // No INFLIGHT_KEY write occurred on the idle tick.
    expect(setSpy).not.toHaveBeenCalledWith("download_inflight_v1", expect.anything());
    expect(localStorage.getItem("download_inflight_v1")).toBe(inflightLs);
    setSpy.mockRestore();
  });

  it("a tick with changed bytes updates in-memory state immediately", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    const jobId = useTransfers.getState().inflight[0].jobId;
    listReturns = [job({ jobId, bytes: 250, totalBytes: 1000 })];
    await useTransfers.getState().refresh();
    const jobsBefore = useTransfers.getState().jobs;

    listReturns = [job({ jobId, bytes: 750, totalBytes: 1000 })]; // progress moved
    await useTransfers.getState().refresh();

    // The UI-facing state always reflects the latest bytes, tick to tick —
    // only the localStorage persistence is throttled (see below).
    expect(useTransfers.getState().jobs).not.toBe(jobsBefore);
    expect(useTransfers.getState().inflight[0].bytes).toBe(750);
  });

  it("throttles the bytes-only localStorage write, then flushes on the Nth tick", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    const jobId = useTransfers.getState().inflight[0].jobId;
    // Job start already persisted bytes: 0 to disk.

    listReturns = [job({ jobId, bytes: 250, totalBytes: 1000 })];
    await useTransfers.getState().refresh(); // tick 1: throttled
    listReturns = [job({ jobId, bytes: 500, totalBytes: 1000 })];
    await useTransfers.getState().refresh(); // tick 2: throttled
    expect(JSON.parse(localStorage.getItem("download_inflight_v1")!)[0].bytes).toBe(0);

    listReturns = [job({ jobId, bytes: 750, totalBytes: 1000 })];
    await useTransfers.getState().refresh(); // tick 3: flushes
    expect(JSON.parse(localStorage.getItem("download_inflight_v1")!)[0].bytes).toBe(750);
  });

  it("persists immediately when a job leaves the in-flight set, regardless of the throttle", async () => {
    useTransfers.getState().enqueue("drive_x", [item("a")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    const jobId = useTransfers.getState().inflight[0].jobId;
    listReturns = [job({ jobId, bytes: 250, totalBytes: 1000 })];
    await useTransfers.getState().refresh(); // tick 1: throttled, doesn't flush

    listReturns = [job({ jobId, bytes: 1000, totalBytes: 1000, finished: true, success: true })];
    await useTransfers.getState().refresh(); // job finishes — membership change, persists now

    expect(useTransfers.getState().inflight).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("download_inflight_v1")!)).toHaveLength(0);
  });
});
