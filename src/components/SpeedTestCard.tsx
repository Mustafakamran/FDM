import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowDown, ArrowUp, Gauge, Loader2, Zap, MapPin, Server } from "lucide-react";
import { startSpeedTest, cancelSpeedTest } from "../lib/tauri/commands";
import { SpeedGraph } from "./ui/SpeedGraph";

interface DoneResult {
  downloadMbps: number;
  uploadMbps: number;
  peakDownMbps: number;
  peakUpMbps: number;
  pingMs: number | null;
}
interface Meta {
  clientIp: string;
  clientLoc: string;
  serverColo: string;
}

const HISTORY_LENGTH = 48;
type Phase = "download" | "upload" | null;

/** Measures the raw internet connection (download + upload + ping) against
 * Cloudflare's edge — like fast.com — independent of any connected drive. */
export function SpeedTestCard() {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [phase, setPhase] = useState<Phase>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [down, setDown] = useState(0);
  const [up, setUp] = useState(0);
  const [downHist, setDownHist] = useState<number[]>([]);
  const [upHist, setUpHist] = useState<number[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [result, setResult] = useState<DoneResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  useEffect(() => {
    const unlisten: Promise<() => void>[] = [];
    unlisten.push(listen<Meta>("speedtest-meta", (e) => setMeta(e.payload)));
    unlisten.push(listen<{ pingMs: number | null }>("speedtest-ping", (e) => setPingMs(e.payload.pingMs)));
    unlisten.push(
      listen<{ phase: Phase; mbps: number }>("speedtest-progress", (e) => {
        const { phase: p, mbps } = e.payload;
        setPhase(p);
        if (p === "upload") {
          setUp(mbps);
          setUpHist((h) => [...h, mbps].slice(-HISTORY_LENGTH));
        } else {
          setDown(mbps);
          setDownHist((h) => [...h, mbps].slice(-HISTORY_LENGTH));
        }
      }),
    );
    unlisten.push(
      listen<DoneResult>("speedtest-done", (e) => {
        setResult(e.payload);
        setDown(e.payload.downloadMbps);
        setUp(e.payload.uploadMbps);
        setPhase(null);
        setState("done");
      }),
    );
    unlisten.push(listen<{ error: string }>("speedtest-error", (e) => { setError(e.payload.error); setState("error"); }));
    unlisten.push(listen("speedtest-cancelled", () => { setState("idle"); setPhase(null); }));
    return () => unlisten.forEach((p) => void p.then((f) => f()));
  }, []);

  const run = () => {
    runId.current++;
    setState("running");
    setPhase(null);
    setPingMs(null);
    setDown(0);
    setUp(0);
    setDownHist([]);
    setUpHist([]);
    setResult(null);
    setError(null);
    void startSpeedTest().catch((e) => { setError(e instanceof Error ? e.message : String(e)); setState("error"); });
  };
  const cancel = () => void cancelSpeedTest();

  const activeHist = phase === "upload" ? upHist : downHist;
  const phaseLabel = state === "done" ? "Complete" : phase === "upload" ? "Testing upload…" : phase === "download" ? "Testing download…" : "Starting…";

  return (
    <div className="rounded-[15px] border border-[var(--line)] bg-[var(--card)] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
          <Zap size={15} className="text-[var(--acc)]" /> Speed test
        </div>
        {state === "running" ? (
          <button onClick={cancel} className="rounded-full border border-[var(--line)] px-3 py-1 text-[12px] font-semibold text-[var(--mut)] hover:border-[var(--line2)]">Cancel</button>
        ) : (
          <button onClick={run} className="rounded-full bg-[var(--acc)] px-3 py-1 text-[12px] font-semibold text-[var(--onacc)] hover:opacity-90">
            {state === "done" || state === "error" ? "Run again" : "Run test"}
          </button>
        )}
      </div>

      {state === "idle" && (
        <p className="mt-3 text-[12px] text-[var(--faint)]">
          Measures your connection's download &amp; upload throughput and ping against Cloudflare's edge (~15s), independent of any connected drive.
        </p>
      )}

      {state === "error" && <p className="mt-3 text-[12px] text-[var(--err)]">{error}</p>}

      {(state === "running" || state === "done") && (
        <>
          <div className="mt-3 flex items-center gap-2 text-[11.5px] font-medium text-[var(--faint)]">
            {state === "running" && <Loader2 size={12} className="animate-spin" />}
            {phaseLabel}
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2">
            <Metric icon={<ArrowDown size={13} />} label="Download" value={down} unit="Mbps" active={phase === "download"} />
            <Metric icon={<ArrowUp size={13} />} label="Upload" value={up} unit="Mbps" active={phase === "upload"} />
            <Metric icon={<Gauge size={13} />} label="Ping" value={pingMs} unit="ms" digits={0} />
          </div>

          <div className="mt-3 h-14">
            <SpeedGraph samples={activeHist} color="var(--acc)" />
          </div>

          {(meta || result) && (
            <div className="mt-3 space-y-1.5 border-t border-[var(--line)] pt-3 text-[11.5px] text-[var(--faint)]">
              {meta && (
                <>
                  <div className="flex items-center gap-1.5">
                    <MapPin size={12} className="shrink-0" />
                    <span className="text-[var(--mut)]">Client</span>
                    <span className="truncate tnum">{meta.clientIp}{meta.clientLoc ? ` · ${meta.clientLoc}` : ""}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Server size={12} className="shrink-0" />
                    <span className="text-[var(--mut)]">Server</span>
                    <span className="truncate">Cloudflare{meta.serverColo ? ` · ${meta.serverColo}` : ""}</span>
                  </div>
                </>
              )}
              {result && (
                <div className="tnum pt-0.5">Peak {result.peakDownMbps.toFixed(0)} ↓ / {result.peakUpMbps.toFixed(0)} ↑ Mbps</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ icon, label, value, unit, active, digits = 1 }: { icon: React.ReactNode; label: string; value: number | null; unit: string; active?: boolean; digits?: number }) {
  const has = value != null && value > 0;
  // For a Mbps (megabit) reading also show MB/s (megabytes ÷ 8), which is what
  // download sizes are measured in.
  const mbytes = unit === "Mbps" && has ? value! / 8 : null;
  return (
    <div className={`rounded-[11px] border p-2.5 transition-colors ${active ? "border-[var(--acc)] bg-[var(--accw)]" : "border-[var(--line)]"}`}>
      <div className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--faint)]">
        {icon} {label}
      </div>
      <div className="tnum mt-1 text-[21px] font-bold leading-none tracking-[-0.02em] text-[var(--ink)]">
        {has ? value!.toFixed(digits) : "—"}
        <span className="ml-1 text-[11px] font-medium text-[var(--faint)]">{unit}</span>
      </div>
      {mbytes != null && (
        <div className="tnum mt-1 text-[11px] text-[var(--faint)]">{mbytes.toFixed(mbytes < 10 ? 2 : 1)} MB/s</div>
      )}
    </div>
  );
}
