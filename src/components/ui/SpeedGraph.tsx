import { useEffect, useId, useRef, useState } from "react";
import { formatSpeed } from "../../lib/format";

/** Catmull-Rom spline → cubic-bezier path, so the speed curve is smooth rather
 *  than a chain of straight segments. */
function smoothPath(p: readonly (readonly [number, number])[]): string {
  if (p.length < 2) return "";
  let d = `M ${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * Live speed graph. A smooth filled area under the speed curve with the current
 * and peak speed labelled. To read as real-time rather than stepping once per
 * poll, the whole curve is drifted left continuously (requestAnimationFrame,
 * transform only — no React re-render per frame) between samples: each new
 * sample shifts the rolling buffer left by exactly one step, and the animation
 * is re-anchored so the drift lands precisely as the next sample arrives. The
 * drift speed adapts to the observed poll cadence, so 1 s or 2 s polls both look
 * continuous.
 */
export function SpeedGraph({
  samples,
  height = 56,
  color = "var(--dl)",
  speed,
  peak,
}: {
  samples: number[];
  height?: number;
  color?: string;
  /** Current speed (bytes/s) for the overlay label; defaults to the last sample. */
  speed?: number;
  /** Peak speed (bytes/s) for the overlay label. */
  peak?: number;
}) {
  const uid = useId().replace(/[:]/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const [w, setW] = useState(320);

  // Scroll animation state, kept in refs so the RAF loop mutates the transform
  // directly (no per-frame setState / path rebuild).
  const anchor = useRef(performance.now());
  const interval = useRef(1000);
  const step = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(80, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-anchor on each new sample and learn the real poll interval (EMA), so the
  // leftward drift finishes exactly as the next sample lands.
  const n = samples.length;
  const last = samples[n - 1] ?? 0;
  useEffect(() => {
    const now = performance.now();
    const dt = now - anchor.current;
    if (dt > 120 && dt < 6000) interval.current = interval.current * 0.6 + dt * 0.4;
    anchor.current = now;
  }, [n, last]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - anchor.current) / interval.current);
      if (gRef.current) gRef.current.setAttribute("transform", `translate(${(-p * step.current).toFixed(2)},0)`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (n < 2) {
    return (
      <div ref={ref} style={{ height }} className="flex items-center justify-center text-[11px] text-[var(--faint)]">
        Waiting for data…
      </div>
    );
  }

  const h = height;
  const st = w / (n - 1);
  step.current = st;
  const max = Math.max(...samples, 1);
  const y = (s: number) => h - 3 - (Math.max(0, s) / max) * (h - 11);
  // Plot points at i*step, plus one trailing duplicate a step to the right so
  // the left-drift never exposes a gap at the right edge.
  const pts: [number, number][] = samples.map((s, i) => [i * st, y(s)]);
  pts.push([n * st, y(last)]);
  const line = smoothPath(pts);
  const area = `${line} L ${(n * st).toFixed(1)} ${h} L 0 ${h} Z`;

  return (
    <div ref={ref} style={{ height }} className="relative w-full overflow-hidden">
      <svg width={w} height={h} className="block" shapeRendering="geometricPrecision">
        <defs>
          <linearGradient id={`g-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.30" />
            <stop offset="1" stopColor={color} stopOpacity="0.015" />
          </linearGradient>
        </defs>
        <g ref={gRef}>
          <path d={area} fill={`url(#g-${uid})`} />
          <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        </g>
        {/* Fixed leading dot at the right edge = the live head of the curve. */}
        <circle cx={w - 1.5} cy={y(last)} r={2.6} fill={color} />
      </svg>
      {/* Overlay: current speed (left) and peak (right) — only when the caller
          opts in by passing a live speed (keeps the speed-test graph clean). */}
      {speed !== undefined && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between px-1.5 pt-0.5 font-mono text-[10px]">
          <span className="font-semibold" style={{ color }}>{formatSpeed(Math.max(0, speed))}</span>
          {peak ? <span className="text-[var(--faint)]">peak {formatSpeed(peak)}</span> : null}
        </div>
      )}
    </div>
  );
}
