export interface VirtualWindowInput {
  /** Total number of data rows (header row excluded). */
  rowCount: number;
  /** Current scroll offset of the grid body, in pixels. */
  scrollTop: number;
  /** Height of the scrollable body region, in pixels. */
  viewportHeight: number;
  /** Fixed row height, in pixels. */
  rowHeight: number;
  /** Extra rows rendered above/below the viewport. */
  overscan?: number;
}

export interface VirtualWindow {
  /** First data row index to render (inclusive). */
  startIndex: number;
  /** First data row index NOT to render (exclusive). */
  endIndex: number;
  /** Spacer height above the window, in pixels. */
  offsetTop: number;
  /** Full scrollable height of all data rows, in pixels. */
  totalHeight: number;
}

/**
 * Fixed-height row windowing: which rows must be in the DOM for a given
 * scroll position. Pure so it can be unit-tested without layout (jsdom has
 * no layout engine; the grid derives its heights from row counts instead of
 * measuring).
 */
export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { rowCount, scrollTop, viewportHeight, rowHeight } = input;
  const overscan = input.overscan ?? 2;
  const totalHeight = rowCount * rowHeight;
  if (rowCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: Math.max(0, totalHeight) };
  }

  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const scroll = Math.max(0, Math.min(scrollTop, maxScroll));
  const rawStart = Math.floor(scroll / rowHeight);
  const start = Math.max(0, rawStart - overscan);
  const visible = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const end = Math.min(rowCount, rawStart + visible + overscan);

  return {
    startIndex: start,
    endIndex: Math.max(start, end),
    offsetTop: start * rowHeight,
    totalHeight,
  };
}
