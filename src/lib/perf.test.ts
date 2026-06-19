import { describe, it, expect } from "vitest";
import { toRcConfig, PRESETS } from "./perf";

describe("toRcConfig", () => {
  it("maps tuning to rclone _config keys", () => {
    expect(toRcConfig(PRESETS.Turbo)).toEqual({
      Transfers: 8,
      MultiThreadStreams: 8,
      MultiThreadCutoff: "250Mi",
      BwLimit: "off",
    });
  });

  it("formats a bandwidth cap when set", () => {
    expect(toRcConfig({ transfers: 4, multiThreadStreams: 4, multiThreadCutoffMB: 250, bwLimitMB: 50 }).BwLimit).toBe(
      "50M",
    );
  });
});
