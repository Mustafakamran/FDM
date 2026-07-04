/**
 * FDM brand mark — a downward arrow settling into an open tray. Renders in the
 * app's accent color: accent-tinted squircle with accent-colored arrows, so the
 * mark matches the selected accent for EVERY preset (including the monochrome
 * default, where a solid-accent background would leave white arrows invisible).
 * Drawn as an SVG so it's crisp at every size.
 */
export function LogoMark({ size = 32, radius }: { size?: number; radius?: number }) {
  const r = radius ?? Math.round(size * 0.3);
  const g = size * 0.58;
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, borderRadius: r, background: "var(--accent-weak)", boxShadow: "0 2px 8px var(--accent-glow)" }}
    >
      <svg width={g} height={g} viewBox="0 0 18 18" fill="none" aria-hidden="true">
        {/* shaft + chevron — the download arrow */}
        <path d="M9 2.6 V10.4 M5.4 7.2 L9 10.9 L12.6 7.2" stroke="var(--accent)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        {/* open tray */}
        <path d="M4 12.8 V14.6 H14 V12.8" stroke="var(--accent)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** Mark + "FDM" wordmark — one ink color (all black in light, all white in dark). */
export function Logo({ size = 32, wordSize = 16 }: { size?: number; wordSize?: number }) {
  return (
    <span className="flex items-center gap-[11px]">
      <LogoMark size={size} />
      <span style={{ fontSize: wordSize, fontWeight: 700, letterSpacing: "-.02em" }} className="text-[var(--ink)]">
        FDM
      </span>
    </span>
  );
}
