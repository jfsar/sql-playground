import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ColumnInfo, SqlValue } from "../../shared/contracts";
import { computeVirtualWindow } from "./virtualRows";

/** Fixed row height in pixels — virtualization math depends on it. */
export const ROW_HEIGHT = 30;
/** Data rows visible before the grid scrolls (plan SC-05: 1,000-row renders). */
export const MAX_VISIBLE_ROWS = 10;
const OVERSCAN = 4;

export function formatValue(v: SqlValue): string {
  if (v === null) return "NULL";
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === "bigint") return `${v}n`;
  return String(v);
}

export interface ResultsGridProps {
  columns: ColumnInfo[];
  rows: SqlValue[][];
}

interface CellPos {
  row: number;
  col: number;
}

/**
 * Virtualized results grid with the ARIA grid pattern from NFR-11
 * (designed Week 4, audited Week 9): `aria-rowcount`/`aria-colcount` over the
 * full result, `aria-rowindex`/`aria-colindex` on the rendered window, a
 * roving tabindex (one tab stop into the grid), and arrow-key navigation.
 *
 * Rows are windowed by fixed pixel height (see virtualRows.ts); heights are
 * derived from row counts so the grid behaves identically without layout
 * (jsdom).
 */
export function ResultsGrid({ columns, rows }: ResultsGridProps) {
  const rowCount = rows.length;
  const colCount = columns.length;
  const bodyViewport = Math.min(rowCount, MAX_VISIBLE_ROWS) * ROW_HEIGHT;
  const gridHeight =
    rowCount === 0 ? ROW_HEIGHT : ROW_HEIGHT + Math.min(rowCount, MAX_VISIBLE_ROWS) * ROW_HEIGHT;

  const scrollRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<(HTMLElement | null)[][]>([]);
  const pendingFocus = useRef<CellPos | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusPos, setFocusPos] = useState<CellPos>({ row: 0, col: 0 });
  const hintId = useId();

  const { startIndex, endIndex, offsetTop, totalHeight } = computeVirtualWindow({
    rowCount,
    scrollTop,
    viewportHeight: bodyViewport,
    rowHeight: ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  // New results: start at the top with the first cell as the tab stop.
  useEffect(() => {
    setScrollTop(0);
    setFocusPos({ row: 0, col: 0 });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [rows]);

  // Focus a cell after a keyboard move (it may have just entered the window).
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    cellRefs.current[target.row]?.[target.col]?.focus();
  });

  const setCellRef =
    (row: number, col: number) =>
    (el: HTMLElement | null): void => {
      const rowRefs = (cellRefs.current[row] ??= []);
      rowRefs[col] = el;
    };

  const moveTo = (row: number, col: number): void => {
    if (rowCount === 0 || colCount === 0) return;
    const nextRow = Math.min(Math.max(row, 0), rowCount - 1);
    const nextCol = Math.min(Math.max(col, 0), colCount - 1);

    const el = scrollRef.current;
    if (el) {
      const bodyTop = nextRow * ROW_HEIGHT;
      let nextScroll = scrollTop;
      if (bodyTop < nextScroll) nextScroll = bodyTop;
      else if (bodyTop + ROW_HEIGHT > nextScroll + bodyViewport) {
        nextScroll = bodyTop + ROW_HEIGHT - bodyViewport;
      }
      if (nextScroll !== scrollTop) {
        el.scrollTop = nextScroll;
        setScrollTop(nextScroll);
      }
    }

    if (nextRow === focusPos.row && nextCol === focusPos.col) {
      cellRefs.current[nextRow]?.[nextCol]?.focus();
      return;
    }
    pendingFocus.current = { row: nextRow, col: nextCol };
    setFocusPos({ row: nextRow, col: nextCol });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (rowCount === 0 || colCount === 0) return;
    const { row, col } = focusPos;
    const page = Math.max(1, Math.floor(bodyViewport / ROW_HEIGHT) - 1);
    let nextRow = row;
    let nextCol = col;
    switch (e.key) {
      case "ArrowDown":
        nextRow = row + 1;
        break;
      case "ArrowUp":
        nextRow = row - 1;
        break;
      case "ArrowRight":
        nextCol = col + 1;
        break;
      case "ArrowLeft":
        nextCol = col - 1;
        break;
      case "PageDown":
        nextRow = row + page;
        break;
      case "PageUp":
        nextRow = row - page;
        break;
      case "Home":
        nextRow = e.ctrlKey || e.metaKey ? 0 : row;
        nextCol = 0;
        break;
      case "End":
        nextRow = e.ctrlKey || e.metaKey ? rowCount - 1 : row;
        nextCol = colCount - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    moveTo(nextRow, nextCol);
  };

  const topSpacer = offsetTop;
  const bottomSpacer = Math.max(0, totalHeight - endIndex * ROW_HEIGHT);

  return (
    <>
      <span id={hintId} className="sr-only">
        Query results grid. Arrow keys move between cells, Home and End jump to the start or end of
        a row, and Control or Command with Home or End jumps to the first or last cell.
      </span>
      <div
        ref={scrollRef}
        data-testid="results-grid"
        className="results-grid-scroll overflow-auto"
        style={{ height: gridHeight }}
        onScroll={(e) => setScrollTop(Math.round(e.currentTarget.scrollTop))}
        onKeyDown={handleKeyDown}
      >
        <table
          role="grid"
          aria-label="Query results"
          aria-rowcount={rowCount + 1}
          aria-colcount={colCount}
          aria-describedby={hintId}
          className="w-full border-separate border-spacing-0 text-left text-sm"
        >
          <thead>
            <tr aria-rowindex={1}>
              {columns.map((c, ci) => (
                <th
                  key={`${ci}-${c.name}`}
                  scope="col"
                  aria-colindex={ci + 1}
                  className="sticky top-0 z-10 h-[30px] max-w-[20rem] border-b border-neutral-700 bg-neutral-900 px-2 font-medium text-neutral-200"
                >
                  <span className="block truncate">
                    {c.name}
                    {c.declaredType ? (
                      <span className="ml-1 font-normal text-neutral-500">{c.declaredType}</span>
                    ) : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topSpacer > 0 && (
              <tr aria-hidden="true" style={{ height: topSpacer }}>
                <td colSpan={colCount} style={{ height: topSpacer, padding: 0, border: 0 }} />
              </tr>
            )}
            {rows.slice(startIndex, endIndex).map((row, i) => {
              const rowIndex = startIndex + i;
              return (
                <tr key={rowIndex} aria-rowindex={rowIndex + 2}>
                  {row.map((cell, ci) => {
                    const isFocus = focusPos.row === rowIndex && focusPos.col === ci;
                    const text = formatValue(cell);
                    return (
                      <td
                        key={ci}
                        ref={setCellRef(rowIndex, ci)}
                        role="gridcell"
                        aria-colindex={ci + 1}
                        tabIndex={isFocus ? 0 : -1}
                        onFocus={() => {
                          if (focusPos.row !== rowIndex || focusPos.col !== ci) {
                            setFocusPos({ row: rowIndex, col: ci });
                          }
                        }}
                        className={[
                          "h-[30px] border-b border-neutral-800/60 px-2 align-middle font-mono",
                          "outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500",
                          isFocus ? "bg-neutral-800/70 text-neutral-50" : "text-neutral-100",
                        ].join(" ")}
                      >
                        <span className="block max-w-[20rem] truncate" title={text}>
                          {text}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {bottomSpacer > 0 && (
              <tr aria-hidden="true" style={{ height: bottomSpacer }}>
                <td colSpan={colCount} style={{ height: bottomSpacer, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
