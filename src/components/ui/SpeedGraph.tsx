/**
 * Live bar chart of recent speed samples — the "Steam download" look: a dense
 * histogram with a brighter line tracing the tops, instead of a smooth curve
 * that reads as flat/empty once speed settles. Pure SVG (viewBox-scaled, no
 * charting dependency) so it stays cheap to re-render every tick.
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
  if (samples.length < 2) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-[11px] text-[var(--text-3)]"
      >
        Waiting for data…
      </div>
    );
  }

  const width = 100;
  const max = Math.max(...samples, 1);
  const n = samples.length;
  const slot = width / n;
  const barWidth = Math.max(0.5, slot * 0.62);
  const barHeight = (s: number) => Math.max(0.6, (s / max) * height * 0.92);
  const topX = (i: number) => i * slot + slot / 2;
  const topY = (s: number) => height - barHeight(s);
  const linePath = samples
    .map((s, i) => `${i === 0 ? "M" : "L"} ${topX(i).toFixed(2)} ${topY(s).toFixed(2)}`)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-full w-full">
      {samples.map((s, i) => {
        const h = barHeight(s);
        return (
          <rect
            key={i}
            x={i * slot + (slot - barWidth) / 2}
            y={height - h}
            width={barWidth}
            height={h}
            fill={color}
            fillOpacity={0.5}
          />
        );
      })}
      <path d={linePath} fill="none" stroke={color} strokeWidth={1} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
