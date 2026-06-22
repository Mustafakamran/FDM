import { describe, it, expect } from "vitest";
import {
  playbackMode,
  levelLabel,
  qualityOptions,
  activeQualityLabel,
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
