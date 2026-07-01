import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Gauge, Loader2, Zap } from "lucide-react";
import { startSpeedTest, cancelSpeedTest } from "../lib/tauri/commands";
import { formatSpeed } from "../lib/format";
import { SpeedGraph } from "./ui/SpeedGraph";

interface DoneResult {
  bytes: number;
  elapsedSecs: number;
  mbps: number;
  peakMbps: number;
  pingMs: number | null;
}

const HISTORY_LENGTH = 40;

/** Downloads from a public CDN endpoint for ~8s to measure raw connection
 * throughput — like fast.com, run against Cloudflare's edge rather than a
 * Drive/Dropbox account (so it isn't skewed by provider-side throttling). */
export function SpeedTestCard() {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [mbps, setMbps] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [result, setResult] = useState<DoneResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  useEffect(() => {
    const unlisten: Promise<() => void>[] = [];
    unlisten.push(
      listen<{ pingMs: number | null }>("speedtest-ping", (e) => setPingMs(e.payload.pingMs)),
    );
    unlisten.push(
      listen<{ bytes: number; elapsedSecs: number; mbps: number }>("speedtest-progress", (e) => {
        setMbps(e.payload.mbps);
        setHistory((h) => [...h, e.payload.mbps].slice(-HISTORY_LENGTH));
      }),
    );
    unlisten.push(
      listen<DoneResult>("speedtest-done", (e) => {
        setResult(e.payload);
        setMbps(e.payload.mbps);
        setState("done");
      }),
    );
    unlisten.push(
      listen<{ error: string }>("speedtest-error", (e) => {
        setError(e.payload.error);
        setState("error");
      }),
    );
    unlisten.push(listen("speedtest-cancelled", () => setState("idle")));
    return () => {
      unlisten.forEach((p) => void p.then((f) => f()));
    };
  }, []);

  const run = () => {
    runId.current++;
    setState("running");
    setPingMs(null);
    setMbps(0);
    setHistory([]);
    setResult(null);
    setError(null);
    void startSpeedTest().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    });
  };

  const cancel = () => void cancelSpeedTest();

  return (
    <div className="rounded-[15px] border border-[var(--line)] bg-[var(--card)] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
          <Zap size={15} className="text-[var(--acc)]" /> Speed test
        </div>
        {state === "running" ? (
          <button
            onClick={cancel}
            className="rounded-full border border-[var(--line)] px-3 py-1 text-[12px] font-semibold text-[var(--mut)] hover:border-[var(--line2)]"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={run}
            className="rounded-full bg-[var(--acc)] px-3 py-1 text-[12px] font-semibold text-[var(--onacc)] hover:opacity-90"
          >
            {state === "done" || state === "error" ? "Run again" : "Run test"}
          </button>
        )}
      </div>

      {state === "idle" && (
        <p className="mt-3 text-[12px] text-[var(--faint)]">
          Measures your connection's raw download throughput (~8s), independent of any connected drive.
        </p>
      )}

      {state === "error" && (
        <p className="mt-3 text-[12px] text-[var(--err)]">{error}</p>
      )}

      {(state === "running" || state === "done") && (
        <>
          <div className="mt-3 flex items-end gap-4">
            <div>
              <div className="tnum text-[28px] font-bold leading-none tracking-[-0.02em] text-[var(--ink)]">
                {mbps > 0 ? mbps.toFixed(0) : "—"}
                <span className="ml-1 text-[13px] font-medium text-[var(--faint)]">Mbps</span>
              </div>
              <div className="mt-1 text-[11.5px] text-[var(--faint)]">{formatSpeed((mbps * 1_000_000) / 8)}</div>
            </div>
            {pingMs != null && (
              <div className="pb-1 text-[12px] text-[var(--faint)]">
                <Gauge size={12} className="mb-0.5 inline" /> Ping {pingMs.toFixed(0)} ms
              </div>
            )}
            {state === "running" && <Loader2 size={14} className="mb-1.5 animate-spin text-[var(--faint)]" />}
          </div>
          <div className="mt-3 h-14">
            <SpeedGraph samples={history} color="var(--acc)" />
          </div>
          {result && (
            <div className="mt-2 text-[11.5px] text-[var(--faint)]">
              Peak {result.peakMbps.toFixed(0)} Mbps · {result.elapsedSecs.toFixed(1)}s test
            </div>
          )}
        </>
      )}
    </div>
  );
}
