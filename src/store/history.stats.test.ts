import { describe, it, expect, beforeEach } from "vitest";
import { computeFinishStats, useHistory, type JobStats } from "./history";
import type { JobStatus } from "../lib/tauri/commands";

const job = (over: Partial<JobStatus>): JobStatus => ({
  jobId: 1, accountId: "drive1", name: "A", dest: "/d", totalBytes: 100, bytes: 100,
  speed: 0, eta: null, finished: true, success: true, cancelled: false, error: "",
  kind: "download", ...over,
});

describe("computeFinishStats", () => {
  it("derives duration and average speed from start/finish + size", () => {
    const stats: JobStats = { startedAt: 1_000, peakSpeed: 500, minSpeed: 100, lastAt: 4_000 };
    // 2 MB downloaded over 4s → 0.5 MB/s.
    const out = computeFinishStats(2 * 1024 * 1024, stats, 5_000);
    expect(out.startedAt).toBe(1_000);
    expect(out.finishedAt).toBe(5_000);
    expect(out.durationMs).toBe(4_000); // 5000 − 1000
    // avg = size / durationSeconds = 2MiB / 4 = 0.5 MiB/s, rounded.
    expect(out.avgSpeed).toBe(Math.round((2 * 1024 * 1024) / 4));
    expect(out.maxSpeed).toBe(500);
    expect(out.minSpeed).toBe(100);
  });

  it("falls back to the last sample time when no finish time is given", () => {
    const stats: JobStats = { startedAt: 1_000, peakSpeed: 10, lastAt: 3_000 };
    const out = computeFinishStats(1000, stats, 0);
    expect(out.durationMs).toBe(2_000); // 3000 − 1000
    // finishedAt is only stamped when we actually have a finish time.
    expect(out.finishedAt).toBeUndefined();
  });

  it("yields undefined duration/avg when there is no start time", () => {
    const out = computeFinishStats(1000, undefined, 5_000);
    expect(out.startedAt).toBeUndefined();
    expect(out.durationMs).toBeUndefined();
    expect(out.avgSpeed).toBeUndefined();
  });

  it("does not divide by zero for an instantaneous transfer", () => {
    const stats: JobStats = { startedAt: 1_000, lastAt: 1_000 };
    const out = computeFinishStats(1000, stats, 1_000); // finish == start
    expect(out.durationMs).toBeUndefined(); // not > start
    expect(out.avgSpeed).toBeUndefined();
  });

  it("yields no avg speed for a zero-byte download", () => {
    const stats: JobStats = { startedAt: 1_000, lastAt: 3_000 };
    const out = computeFinishStats(0, stats, 3_000);
    expect(out.durationMs).toBe(2_000);
    expect(out.avgSpeed).toBeUndefined();
  });
});

describe("useHistory.record dedupe", () => {
  beforeEach(() => useHistory.getState().clear());

  it("ignores jobs that are still running", () => {
    useHistory.getState().record(job({ finished: false, cancelled: false }));
    expect(useHistory.getState().items).toHaveLength(0);
  });

  it("logs one entry per finish, not once per poll", () => {
    const j = job({ jobId: 7 });
    useHistory.getState().record(j);
    useHistory.getState().record(j); // same finish, next poll tick
    useHistory.getState().record(j);
    expect(useHistory.getState().items).toHaveLength(1);
  });

  it("still records a NEW download that reuses an old job id (the vanishing bug)", () => {
    // Native/rclone job ids reset across app restarts, so a fresh download can
    // land on an id already in history. It must not be silently deduped away.
    useHistory.getState().record(job({ jobId: 1, name: "First", dest: "/a" }));
    useHistory.getState().record(job({ jobId: 1, name: "Second", dest: "/b" }));
    const items = useHistory.getState().items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name).sort()).toEqual(["First", "Second"]);
    // Unique React keys.
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it("removeEntry frees the key so the same transfer can be re-recorded", () => {
    const j = job({ jobId: 3, name: "Retry me" });
    useHistory.getState().record(j);
    expect(useHistory.getState().items).toHaveLength(1);
    useHistory.getState().removeEntry(3);
    expect(useHistory.getState().items).toHaveLength(0);
    useHistory.getState().record(j); // e.g. user re-downloaded it
    expect(useHistory.getState().items).toHaveLength(1);
  });
});
