/**
 * Live area chart of recent speed samples — the "Windows copy dialog" look: a
 * filled curve under a line, growing left-to-right as new samples arrive.
 * Pure SVG (viewBox-scaled, no charting dependency) so it stays cheap to
 * re-render every tick.
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
  const stepX = width / (samples.length - 1);
  const points = samples.map((s, i) => [i * stepX, height - (s / max) * height * 0.92 - height * 0.04]);
  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-full w-full">
      <path d={areaPath} fill={color} fillOpacity={0.16} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
