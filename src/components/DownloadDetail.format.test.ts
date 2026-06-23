import { describe, it, expect } from "vitest";
import { formatDuration } from "./DownloadDetail";

describe("formatDuration", () => {
  it("formats sub-second and second ranges", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(400)).toBe("<1s");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("formats minute and hour ranges with zero-padding", () => {
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(200_000)).toBe("3m 20s");
    expect(formatDuration(3_600_000)).toBe("1h 00m 00s");
    expect(formatDuration(3_723_000)).toBe("1h 02m 03s");
  });

  it("returns em-dash for missing / invalid input", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
  });
});
