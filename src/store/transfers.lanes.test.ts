import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  useTransfers,
  decideLanes,
  filenameFromUrl,
  HTTP_ACCOUNT_ID,
  type QueueItem,
} from "./transfers";
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
function qItem(over: Partial<QueueItem> & { accountId: string }): QueueItem {
  return {
    id: over.id ?? `q_${over.accountId}`,
    item: item(over.item?.name ?? over.accountId),
    dest: "/dest",
    ...over,
    lane: laneOf(over.accountId),
  };
}
// Inflight is QueueItem + jobId + bytes; the helper only reads lane + jobId.
function inflightItem(accountId: string, jobId: number): QueueItem & { jobId: number; bytes: number } {
  return { ...qItem({ accountId, id: `inf_${jobId}` }), jobId, bytes: 0 };
}

// ── Pure decision helper ────────────────────────────────────────────────────

describe("decideLanes (pure scheduler decision)", () => {
  it("starts startable primary up to the primary limit", () => {
    const queue = [qItem({ accountId: "drive_x", id: "a" }), qItem({ accountId: "drive_x", id: "b" })];
    const d = decideLanes(queue, [], 1, 3);
    expect(d.startPrimary.map((q) => q.id)).toEqual(["a"]);
  });

  it("does NOT start secondary while a primary job is active", () => {
    const queue = [qItem({ accountId: HTTP_ACCOUNT_ID, id: "url" })];
    const inflight = [inflightItem("drive_x", 1)];
    const d = decideLanes(queue, inflight, 1, 3);
    expect(d.startSecondary).toEqual([]);
  });

  it("does NOT start secondary while a startable primary is queued", () => {
    const queue = [qItem({ accountId: "drive_x", id: "p" }), qItem({ accountId: HTTP_ACCOUNT_ID, id: "url" })];
    const d = decideLanes(queue, [], 0, 3); // 0 primary slots, so primary can't start either
    expect(d.startSecondary).toEqual([]);
  });

  it("auto-pauses every active secondary when primary becomes busy", () => {
    const queue = [qItem({ accountId: "drive_x", id: "p" })]; // startable primary => primaryBusy
    const inflight = [inflightItem(HTTP_ACCOUNT_ID, 10), inflightItem(HTTP_ACCOUNT_ID, 11)];
    const d = decideLanes(queue, inflight, 1, 3);
    expect(d.autoPauseSecondary.sort()).toEqual([10, 11]);
    expect(d.startSecondary).toEqual([]);
  });

  it("starts secondary once the primary lane is drained", () => {
    const queue = [qItem({ accountId: HTTP_ACCOUNT_ID, id: "url" })];
    const d = decideLanes(queue, [], 1, 3);
    expect(d.startSecondary.map((q) => q.id)).toEqual(["url"]);
    expect(d.autoPauseSecondary).toEqual([]);
  });

  it("resumes auto-paused secondary before plain-queued secondary", () => {
    const queue = [
      qItem({ accountId: HTTP_ACCOUNT_ID, id: "plain" }),
      qItem({ accountId: HTTP_ACCOUNT_ID, id: "gated", autoPaused: true }),
    ];
    const d = decideLanes(queue, [], 1, 1); // only one slot
    expect(d.startSecondary.map((q) => q.id)).toEqual(["gated"]);
  });

  it("respects the secondary concurrency limit", () => {
    const queue = [
      qItem({ accountId: HTTP_ACCOUNT_ID, id: "1" }),
      qItem({ accountId: HTTP_ACCOUNT_ID, id: "2" }),
      qItem({ accountId: HTTP_ACCOUNT_ID, id: "3" }),
      qItem({ accountId: HTTP_ACCOUNT_ID, id: "4" }),
    ];
    const d = decideLanes(queue, [], 1, 3);
    expect(d.startSecondary).toHaveLength(3);
  });

  it("respects the primary concurrency limit with active jobs counted", () => {
    const queue = [qItem({ accountId: "drive_x", id: "a" }), qItem({ accountId: "drive_x", id: "b" })];
    const inflight = [inflightItem("drive_x", 1)]; // 1 of 2 slots used
    const d = decideLanes(queue, inflight, 2, 3);
    expect(d.startPrimary.map((q) => q.id)).toEqual(["a"]);
  });

  it("never auto-resumes a user-paused secondary (it's not startable)", () => {
    const queue = [qItem({ accountId: HTTP_ACCOUNT_ID, id: "userpaused", paused: true })];
    const d = decideLanes(queue, [], 1, 3);
    expect(d.startSecondary).toEqual([]);
  });
});

describe("filenameFromUrl", () => {
  it("uses the decoded last path segment", () => {
    expect(filenameFromUrl("https://example.com/files/clip%20one.mp4")).toBe("clip one.mp4");
    expect(filenameFromUrl("https://example.com/a/b/report.pdf?x=1#y")).toBe("report.pdf");
  });
  it("falls back to 'download' when there's no segment", () => {
    expect(filenameFromUrl("https://example.com/")).toBe("download");
    expect(filenameFromUrl("")).toBe("download");
  });
});

// ── Store integration ───────────────────────────────────────────────────────

let nextJobId = 1;
let listReturns: JobStatus[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  nextJobId = 1;
  listReturns = [];
  useTransfers.setState({ jobs: [], queue: [], inflight: [], concurrency: 1, secondaryConcurrency: 3, dockOpen: true });
  invokeMock.mockImplementation((cmd: string, args: { accountId?: string } = {}) => {
    if (cmd === "start_download") {
      const id = nextJobId++;
      return Promise.resolve([job({ jobId: id, accountId: args.accountId ?? "drive_x" })]);
    }
    if (cmd === "list_jobs") return Promise.resolve(listReturns);
    return Promise.resolve(undefined);
  });
});

afterEach(() => useTransfers.getState().stopPolling());

describe("lane scheduler (store)", () => {
  it("enqueueUrl tags the item with the secondary lane and an http account", async () => {
    useTransfers.getState().enqueueUrl("https://example.com/a/video.mp4", "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    const inf = useTransfers.getState().inflight[0];
    expect(inf.accountId).toBe(HTTP_ACCOUNT_ID);
    expect(inf.lane).toBe("secondary");
    expect(inf.item.name).toBe("video.mp4");
    expect(inf.item.id).toBe("https://example.com/a/video.mp4");
  });

  it("does not start a secondary download while a primary is active", async () => {
    // Enqueue a primary first (it starts), then a URL — the URL must stay queued.
    useTransfers.getState().enqueue("drive_x", [item("big.mov")], "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    useTransfers.getState().enqueueUrl("https://example.com/file.zip", "/dest");
    await useTransfers.getState().pump();
    const s = useTransfers.getState();
    expect(s.inflight.every((i) => i.lane === "primary")).toBe(true);
    expect(s.queue.some((q) => q.lane === "secondary")).toBe(true);
  });

  it("auto-pauses an active secondary when a primary starts", async () => {
    // Start a URL download alone (primary lane empty -> it runs).
    useTransfers.getState().enqueueUrl("https://example.com/file.zip", "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    expect(useTransfers.getState().inflight[0].lane).toBe("secondary");

    // Now enqueue a primary — it preempts the secondary.
    useTransfers.getState().enqueue("drive_x", [item("big.mov")], "/dest");
    await vi.waitFor(() => {
      const s = useTransfers.getState();
      expect(s.inflight).toHaveLength(1);
      expect(s.inflight[0].lane).toBe("primary");
    });
    const s = useTransfers.getState();
    const gated = s.queue.find((q) => q.lane === "secondary");
    expect(gated?.autoPaused).toBe(true);
    expect(gated?.paused).toBeFalsy();
    // The auto-pause is persisted so a relaunch restores the gated state.
    const persisted = JSON.parse(localStorage.getItem("download_queue_v1")!) as QueueItem[];
    expect(persisted.find((q) => q.accountId === HTTP_ACCOUNT_ID)?.autoPaused).toBe(true);
  });

  it("auto-resumes the gated secondary when the primary lane drains", async () => {
    // Secondary running, primary preempts it.
    useTransfers.getState().enqueueUrl("https://example.com/file.zip", "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    useTransfers.getState().enqueue("drive_x", [item("big.mov")], "/dest");
    await vi.waitFor(() => {
      const s = useTransfers.getState();
      expect(s.inflight).toHaveLength(1);
      expect(s.inflight[0].lane).toBe("primary");
    });
    const primaryJobId = useTransfers.getState().inflight[0].jobId;

    // Primary finishes -> refresh drains the primary lane -> secondary resumes.
    listReturns = [job({ jobId: primaryJobId, accountId: "drive_x", finished: true, success: true })];
    await useTransfers.getState().refresh();
    await vi.waitFor(() => {
      const s = useTransfers.getState();
      expect(s.inflight).toHaveLength(1);
      expect(s.inflight[0].lane).toBe("secondary");
    });
    const s = useTransfers.getState();
    expect(s.inflight[0].autoPaused).toBe(false);
    expect(s.queue.some((q) => q.lane === "secondary")).toBe(false);
  });

  it("never auto-resumes a user-paused secondary", async () => {
    // Start a URL download, user-pause it.
    useTransfers.getState().enqueueUrl("https://example.com/file.zip", "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight).toHaveLength(1));
    const jobId = useTransfers.getState().inflight[0].jobId;
    await useTransfers.getState().pause(jobId);
    const paused = useTransfers.getState().queue.find((q) => q.lane === "secondary");
    expect(paused?.paused).toBe(true);

    // Drain everything and pump — the user-paused item must stay paused.
    listReturns = [];
    await useTransfers.getState().refresh();
    await useTransfers.getState().pump();
    const s = useTransfers.getState();
    const still = s.queue.find((q) => q.lane === "secondary");
    expect(still?.paused).toBe(true);
    expect(s.inflight.some((i) => i.lane === "secondary")).toBe(false);
  });

  it("respects per-lane secondary concurrency", async () => {
    useTransfers.setState({ secondaryConcurrency: 2 });
    for (let i = 0; i < 4; i++) useTransfers.getState().enqueueUrl(`https://example.com/f${i}.zip`, "/dest");
    await vi.waitFor(() => expect(useTransfers.getState().inflight.length).toBe(2));
    // Two running, two still queued — the secondary limit caps it.
    expect(useTransfers.getState().inflight).toHaveLength(2);
    expect(useTransfers.getState().queue.filter((q) => q.lane === "secondary")).toHaveLength(2);
  });
});
