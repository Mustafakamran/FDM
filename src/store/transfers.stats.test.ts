import { describe, it, expect, vi } from "vitest";

// transfers.ts imports tauri's invoke transitively; stub it so the pure helper
// can be imported in the node-ish test env.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { accrueStats } from "./transfers";

describe("accrueStats", () => {
  it("sets startedAt on the first sample and never moves it", () => {
    const s1 = accrueStats(undefined, 100, 1_000);
    expect(s1.startedAt).toBe(1_000);
    const s2 = accrueStats(s1, 200, 5_000);
    expect(s2.startedAt).toBe(1_000); // pinned to first observation
    expect(s2.lastAt).toBe(5_000);
  });

  it("tracks peak speed as the running maximum", () => {
    let s = accrueStats(undefined, 100, 1_000);
    s = accrueStats(s, 500, 2_000);
    s = accrueStats(s, 300, 3_000);
    expect(s.peakSpeed).toBe(500);
  });

  it("tracks min speed as the minimum of NON-ZERO samples only", () => {
    let s = accrueStats(undefined, 0, 1_000); // a zero sample (ramp/stall)
    expect(s.minSpeed).toBeUndefined(); // ignored
    s = accrueStats(s, 400, 2_000);
    expect(s.minSpeed).toBe(400);
    s = accrueStats(s, 150, 3_000);
    expect(s.minSpeed).toBe(150);
    s = accrueStats(s, 0, 4_000); // another zero must not lower the floor
    expect(s.minSpeed).toBe(150);
  });

  it("treats a zero opening sample as zero peak, not negative", () => {
    const s = accrueStats(undefined, 0, 1_000);
    expect(s.peakSpeed).toBe(0);
    expect(s.startedAt).toBe(1_000);
  });
});
