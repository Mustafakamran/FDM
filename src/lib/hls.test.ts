import { describe, it, expect } from "vitest";
import {
  playbackMode,
  levelLabel,
  qualityOptions,
  activeQualityLabel,
  conservativeStartLevel,
  AUTO_LEVEL,
} from "./hls";

describe("playbackMode", () => {
  it("prefers hls.js when supported (it carries the quality menu)", () => {
    expect(playbackMode({ hlsSupported: true, nativeHls: true })).toBe("hls");
    expect(playbackMode({ hlsSupported: true, nativeHls: false })).toBe("hls");
  });

  it("uses native HLS when hls.js is unsupported but the webview plays it", () => {
    expect(playbackMode({ hlsSupported: false, nativeHls: true })).toBe("native");
  });

  it("falls back to the direct proxy URL when neither is available", () => {
    expect(playbackMode({ hlsSupported: false, nativeHls: false })).toBe("direct");
  });
});

describe("levelLabel", () => {
  it("maps known rendition heights", () => {
    expect(levelLabel(1080)).toBe("1080p");
    expect(levelLabel(720)).toBe("720p");
    expect(levelLabel(480)).toBe("480p");
  });

  it("labels an unknown/zero height as Auto", () => {
    expect(levelLabel(0)).toBe("Auto");
    expect(levelLabel(-1)).toBe("Auto");
  });
});

describe("qualityOptions", () => {
  it("prepends Auto and lists levels highest-first, preserving hls level indices", () => {
    // hls.js commonly reports levels ascending by bitrate/height.
    const opts = qualityOptions([{ height: 480 }, { height: 720 }, { height: 1080 }]);
    expect(opts).toEqual([
      { level: AUTO_LEVEL, label: "Auto" },
      { level: 2, label: "1080p" },
      { level: 1, label: "720p" },
      { level: 0, label: "480p" },
    ]);
  });

  it("returns just Auto when there are no levels", () => {
    expect(qualityOptions([])).toEqual([{ level: AUTO_LEVEL, label: "Auto" }]);
  });

  it("keeps a single level (always at least the smallest is offered)", () => {
    expect(qualityOptions([{ height: 480 }])).toEqual([
      { level: AUTO_LEVEL, label: "Auto" },
      { level: 0, label: "480p" },
    ]);
  });
});

describe("activeQualityLabel", () => {
  const levels = [{ height: 480 }, { height: 720 }, { height: 1080 }];

  it("annotates Auto with the level ABR is currently loading", () => {
    expect(activeQualityLabel(AUTO_LEVEL, 1, levels)).toBe("Auto 720p");
  });

  it("shows plain Auto when the loading level is unknown", () => {
    expect(activeQualityLabel(AUTO_LEVEL, -1, levels)).toBe("Auto");
  });

  it("shows the picked level's label on a manual selection", () => {
    expect(activeQualityLabel(2, 2, levels)).toBe("1080p");
    expect(activeQualityLabel(0, 0, levels)).toBe("480p");
  });

  it("degrades to Auto if the picked index is out of range", () => {
    expect(activeQualityLabel(9, 9, levels)).toBe("Auto");
  });
});

describe("conservativeStartLevel", () => {
  it("picks the highest rendition at/below 720p (a cheap mid level, never 1080p)", () => {
    // ascending: 0=480, 1=720, 2=1080 → start at 720p (index 1), not the top.
    expect(conservativeStartLevel([{ height: 480 }, { height: 720 }, { height: 1080 }])).toBe(1);
  });

  it("includes a 720p rendition (boundary is inclusive)", () => {
    expect(conservativeStartLevel([{ height: 360 }, { height: 720 }])).toBe(1);
  });

  it("falls back to the lowest rendition when every level is above the cheap cap", () => {
    // ascending: 0=1080, 1=1440 → none ≤720, so start at the lowest (index 0).
    expect(conservativeStartLevel([{ height: 1080 }, { height: 1440 }])).toBe(0);
  });

  it("returns 0 for unknown heights or an empty list", () => {
    expect(conservativeStartLevel([])).toBe(0);
    expect(conservativeStartLevel([{ height: 0 }, { height: 0 }])).toBe(0);
  });

  it("picks the cheap level regardless of hls.js level ordering", () => {
    // descending order: 0=1080, 1=720, 2=480 → highest ≤720 is 720p at index 1.
    expect(conservativeStartLevel([{ height: 1080 }, { height: 720 }, { height: 480 }])).toBe(1);
  });
});
