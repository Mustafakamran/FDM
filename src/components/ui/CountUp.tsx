import { useEffect, useRef, useState } from "react";

/**
 * Animate an integer from its previous value to `value` (easeOutCubic) so stat
 * numbers tick up/down instead of snapping. Uses requestAnimationFrame; cancels
 * cleanly on unmount or a new target. Honors prefers-reduced-motion (jumps).
 */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const dur = 600;
    let start: number | null = null;
    const step = (t: number) => {
      if (start === null) start = t;
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value]);

  return <span className={className}>{display.toLocaleString()}</span>;
}
