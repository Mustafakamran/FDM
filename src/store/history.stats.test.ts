import { describe, it, expect } from "vitest";
import { computeFinishStats, type JobStats } from "./history";

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
