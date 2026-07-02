export interface VirtualRange {
  /** First index to render (inclusive). */
  start: number;
  /** Last index to render (exclusive). */
  end: number;
}

/**
 * Visible row-index range for fixed-height row virtualization, padded by
 * `overscan` rows on each side so a fast scroll doesn't show a blank flash
 * before new rows mount. Degenerates to "render everything" whenever the
 * measurements aren't ready yet (rowHeight/viewportHeight of 0) or the list
 * already fits — callers never need a separate small-list code path.
 */
export function computeVirtualRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  itemCount: number,
  overscan = 8,
): VirtualRange {
  if (itemCount <= 0 || rowHeight <= 0 || viewportHeight <= 0) return { start: 0, end: itemCount };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(itemCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end };
}
