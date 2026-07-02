import { describe, expect, it } from "vitest";
import { computeVirtualRange } from "./virtual-rows";

describe("computeVirtualRange", () => {
  it("renders everything when the list already fits the viewport", () => {
    expect(computeVirtualRange(0, 500, 50, 5)).toEqual({ start: 0, end: 5 });
  });

  it("windows a long list around the current scroll position, padded by overscan", () => {
    // 1000 rows of 50px, viewport 500px tall, scrolled to row 40 (scrollTop 2000).
    const r = computeVirtualRange(2000, 500, 50, 1000, 4);
    expect(r.start).toBe(36); // row 40 - overscan 4
    expect(r.end).toBe(54); // (2000+500)/50=50, +overscan 4
  });

  it("clamps the start to 0 near the top", () => {
    const r = computeVirtualRange(0, 500, 50, 1000, 8);
    expect(r.start).toBe(0);
  });

  it("clamps the end to itemCount near the bottom", () => {
    const r = computeVirtualRange(50_000, 500, 50, 1000, 8);
    expect(r.end).toBe(1000);
  });

  it("renders everything before measurements are ready (rowHeight or viewportHeight 0)", () => {
    expect(computeVirtualRange(0, 0, 50, 1000)).toEqual({ start: 0, end: 1000 });
    expect(computeVirtualRange(0, 500, 0, 1000)).toEqual({ start: 0, end: 1000 });
  });

  it("handles an empty list", () => {
    expect(computeVirtualRange(0, 500, 50, 0)).toEqual({ start: 0, end: 0 });
  });
});
