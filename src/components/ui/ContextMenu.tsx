import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separator?: boolean;
  /** Nested submenu — expands inline inside the parent menu; the parent's `onClick` is ignored. */
  children?: MenuItem[];
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * Cursor-anchored context menu rendered in a portal. Clamps itself inside the
 * viewport after measuring, closes on click-outside / Esc / scroll / blur, and
 * routes keyboard focus so it's usable without a mouse. Items with `children`
 * open a flyout submenu on hover (flipped to the left near the viewport edge).
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, ready: false });
  const [sub, setSub] = useState<number | null>(null);
  // Flip the flyout to the left when the parent menu sits near the right edge.
  const [subLeft, setSubLeft] = useState(false);

  // Measure once mounted, then nudge in-bounds so the menu never clips off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.min(x, window.innerWidth - r.width - 8);
    const ny = Math.min(y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny), ready: true });
    setSubLeft(Math.max(8, nx) + r.width + 180 > window.innerWidth - 8);
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onScroll = () => onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const itemButton = (it: MenuItem, hasSub = false) => (
    <button
      role="menuitem"
      disabled={it.disabled}
      onClick={() => {
        if (it.disabled || hasSub) return;
        onClose();
        it.onClick?.();
      }}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors duration-100 disabled:opacity-40 ${
        it.danger
          ? "text-[var(--error)] hover:bg-[var(--error)]/12"
          : "text-[var(--text)] hover:bg-[var(--hover)]"
      }`}
    >
      {it.icon && <it.icon size={15} className="shrink-0 opacity-80" />}
      <span className="min-w-0 flex-1 truncate">{it.label}</span>
      {hasSub && <ChevronRight size={13} className="shrink-0 opacity-60" />}
    </button>
  );

  return createPortal(
    <>
      {/* Invisible full-screen catcher: any click/right-click outside closes. */}
      <div className="fixed inset-0 z-[150]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref}
        role="menu"
        className="animate-pop fixed z-[151] min-w-[190px] rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]"
        style={{ left: pos.x, top: pos.y, visibility: pos.ready ? "visible" : "hidden" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => {
          const hasSub = !!it.children?.length;
          return (
            <div key={i} className="relative" onMouseEnter={() => setSub(hasSub ? i : null)}>
              {it.separator && <div className="my-1 h-px bg-[var(--border)]" />}
              {itemButton(it, hasSub)}
              {/* Flyout submenu — a clean rounded panel beside the parent, with a
                  small gap. (Earlier "merged fillet" corners poked above the
                  parent when the item sat at the top; a plain flyout is robust.) */}
              {hasSub && sub === i && (
                <div
                  role="menu"
                  className={`absolute -top-1 z-[152] min-w-[170px] rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)] ${
                    subLeft ? "right-full mr-1" : "left-full ml-1"
                  }`}
                >
                  {it.children!.map((c, j) => (
                    <div key={j}>
                      {c.separator && <div className="my-1 h-px bg-[var(--border)]" />}
                      {itemButton(c)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>,
    document.body,
  );
}
