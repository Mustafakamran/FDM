import { useEffect, useId, useRef, useState } from "react";

/**
 * Halftone speed graph — the area under the speed curve filled with a round-dot
 * pattern that fades upward toward the curve (dense/solid at the base, sparse at
 * the top), with a faint line tracing the curve. The dots are a tiled SVG
 * pattern masked by the area path, so it's a handful of nodes regardless of
 * width and the dots stay round (the SVG is sized to real pixels, not stretched).
 */
export function SpeedGraph({
  samples,
  height = 56,
  color = "var(--dl)",
}: {
  samples: number[];
  height?: number;
  color?: string;
}) {
  const uid = useId().replace(/[:]/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(80, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (samples.length < 2) {
    return (
      <div ref={ref} style={{ height }} className="flex items-center justify-center text-[11px] text-[var(--text-3)]">
        Waiting for data…
      </div>
    );
  }

  const h = height;
  const n = samples.length;
  const max = Math.max(...samples, 1);
  const pts = samples.map((s, i) => {
    const x = (i / (n - 1)) * w;
    const y = h - Math.max(1.5, (s / max) * (h - 3));
    return [x, y] as const;
  });
  const area = `M 0 ${h} ${pts.map(([x, y]) => `L ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} L ${w} ${h} Z`;
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

  return (
    <div ref={ref} style={{ height }} className="w-full">
      <svg width={w} height={h} className="block" shapeRendering="geometricPrecision">
        <defs>
          <pattern id={`dots-${uid}`} width={5} height={5} patternUnits="userSpaceOnUse">
            <circle cx={2.5} cy={2.5} r={1.35} fill={color} />
          </pattern>
          {/* Vertical fade: solid at the base, sparse toward the top. */}
          <linearGradient id={`fade-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={h}>
            <stop offset="0" stopColor="#fff" stopOpacity="0.14" />
            <stop offset="0.65" stopColor="#fff" stopOpacity="0.7" />
            <stop offset="1" stopColor="#fff" stopOpacity="1" />
          </linearGradient>
          <mask id={`m-${uid}`}>
            <path d={area} fill={`url(#fade-${uid})`} />
          </mask>
        </defs>
        <rect width={w} height={h} fill={`url(#dots-${uid})`} mask={`url(#m-${uid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={1.25} strokeOpacity={0.5} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}
