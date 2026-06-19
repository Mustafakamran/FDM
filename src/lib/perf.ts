/** Per-download performance tuning, mapped to rclone rc `_config` overrides. */
export interface PerfSettings {
  /** Parallel files. */
  transfers: number;
  /** Ranged streams per big single file (the lever for 300 GB+ files). */
  multiThreadStreams: number;
  /** Files larger than this (MiB) get multi-thread streamed. */
  multiThreadCutoffMB: number;
  /** Bandwidth cap in MB/s; 0 = unlimited. */
  bwLimitMB: number;
}

export const PRESETS: Record<string, PerfSettings> = {
  Turbo: { transfers: 8, multiThreadStreams: 8, multiThreadCutoffMB: 250, bwLimitMB: 0 },
  Balanced: { transfers: 4, multiThreadStreams: 4, multiThreadCutoffMB: 250, bwLimitMB: 0 },
  Gentle: { transfers: 2, multiThreadStreams: 1, multiThreadCutoffMB: 250, bwLimitMB: 0 },
};

export const DEFAULT_PERF: PerfSettings = PRESETS.Balanced;

const KEY = "perf_settings";

export function loadPerf(): PerfSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_PERF, ...JSON.parse(raw) };
  } catch {
    /* fall through to default */
  }
  return DEFAULT_PERF;
}

export function savePerf(s: PerfSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** Map tuning to rclone rc `_config` keys. */
export function toRcConfig(s: PerfSettings): Record<string, unknown> {
  return {
    Transfers: s.transfers,
    MultiThreadStreams: s.multiThreadStreams,
    MultiThreadCutoff: `${s.multiThreadCutoffMB}Mi`,
    BwLimit: s.bwLimitMB > 0 ? `${s.bwLimitMB}M` : "off",
  };
}
