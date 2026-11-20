# ADR-007: SQL workspace — CodeMirror editor, execution contract UI, virtualized ARIA grid

- Status: **Accepted** (implemented and tested Week 4)
- Date: 2026-11-17 (Week 4 of FINAL_PROJECT_PLAN.md)
- Related: plan §3 (editor/results), §5.2 (execution contract), NFR-11
  (accessibility); ADR-002 (plan toolkit), ADR-004 (cancellation, restart
  notice), ADR-006 (DatabaseService entry points)

## Context

Week 4 turns the PoC's textarea into the SQL workspace the plan specifies: a
real editor, the execution-contract UI (sequential statements, stop-on-error,
transaction state), and a results grid that stays responsive at the 1,000-row
cap while carrying the ARIA grid pattern NFR-11 requires **designed now**,
audited in Week 9. SQLite reports error positions as UTF-8 byte offsets
relative to the failing statement; the editor works in UTF-16 document
indices. Nothing may roll back silently (plan §5.2 rule 6), and cancellation
stays ADR-004's worker restart.

## Decision

**CodeMirror 6, deliberately minimal** (`features/sql-editor/SqlEditor.tsx`):

- Extensions: line numbers, history, SQL/SQLite highlighting, bracket
  closing, line wrapping, search/selection-match — **no autocomplete package**
  (plan marks autocomplete as Future) and **Tab is not bound to indent**, so
  keyboard users can leave the editor (NFR-11). The view is created once;
  callbacks reach it through refs. The `sql-input` testid sits on
  `.cm-content`, which Playwright fills like a textarea; CodeMirror's own
  textbox semantics and label stay on.

**Run-selection** (plan §7 Week 4):

- A non-empty selection makes run/explain execute **only the selection**;
  shortcuts `Mod-Enter` (run) and `Mod-Shift-Enter` (explain) are bound in the
  editor keymap. The App owns the selection (`onSelectionChange`, null when
  empty) instead of holding an editor ref, and the Run button label mirrors it
  (`Run (⌘↵)` vs `Run selection (⌘↵)`). The selection's `from` becomes the
  `docStart` used to map error positions back into the document.

**Error position chain** (plan §5.2 rule 6): `sqlite3_error_offset`
(statement-relative UTF-8 bytes) → `byteOffsetToJsIndex` → + `span.start` +
`docStart` → `indexToLineColumn` → rendered as "line N, column M", a caret
line under the token in the statement card, and a `.cm-error-mark` underline
in the editor. Each run snapshots `{doc, docStart}` (`runContext`) so the
position stays anchored to the text that produced it; any edit clears the
mark. Helpers live in `shared/textPosition.ts` (pure, unit-tested).

**Results grid: hand-rolled virtualization + ARIA grid** — no new dependency:

- Fixed 30 px rows; a 10-row viewport window with overscan 4 renders a window
  of `<tr>`s between spacer rows, so 1,000 rows never enter the DOM.
  Heights derive from row counts (identical behavior without layout), which
  keeps the grid unit-testable in jsdom.
- A single-statement result fills the available results height instead of the
  fixed 10-row window (`fill`): a `ResizeObserver`-measured viewport drives the
  same window math (count-derived fallback when unmeasured/jsdom), so only the
  grid scrolls. Multi-statement lists keep the fixed window and the outer
  results panel scrolls them.
- `role="grid"` with `aria-rowcount`/`aria-colcount` over the **full** result,
  `aria-rowindex`/`aria-colindex` on the rendered window, a roving tabindex
  (exactly one tab stop), and arrow/Page/Home/End/Ctrl+Home/Ctrl+End
  navigation that scrolls the window and moves focus after render.
- At the cap: a `role="status"` truncation notice ("row cap of 1000") and the
  timing label becomes "engine time (first N rows)".

**Transaction indicator and cancellation**:

- `response.inTransaction` renders "open transaction" with **Commit** and
  **Rollback** buttons that execute synthetic `COMMIT;`/`ROLLBACK;` scripts —
  never editor content — and synthetic runs never set the editor's error
  mark. The Cancel button exists only while a run is in flight and is wired
  to the ADR-004 worker restart.
- Restarting with a pre-restart `inTransaction: true` shows the ADR-004
  notice (`restart-transaction-notice`): "SQLite rolled back your open
  transaction (worker restarted)" — as ADR-004 deferred to this week.

## Verification (Week 4)

- Unit: `textPosition` (byte→UTF-16 offsets incl. surrogates, line/column,
  mark ranges), `virtualRows` window math, ResultsGrid keyboard/ARIA
  behavior, StatementBlock truncation/position/caret, SqlEditor
  shortcuts/mark/selection — 152 tests green (`pnpm test`).
- E2E (`e2e/week4.spec.ts`, Chromium): shortcuts run whole document and the
  selection alone, explain via shortcut, error line/column + mark cleared on
  edit, truncation notice + virtualized window (14 cells in the DOM for 1,000
  rows; Ctrl+End lands on row 1,000), ARIA grid keyboard navigation,
  Commit/Rollback verified by the data they keep or discard, restart notice,
  Cancel button — 19 e2e tests green on the dev server (CI reruns against the
  production build).
- `pnpm lint` and `pnpm typecheck` pass.

## Consequences

- Selection state lives in App, so any future selection-aware feature (e.g.
  explain-diff) reuses it; an empty selection always falls back to the whole
  document, so stale selections cannot silently truncate a run.
- Virtualization is homegrown with fixed row heights: cheap and dependency-
  free. The Week 9 audit (ADR-011) re-checked the grid semantics and keyboard
  path; variable-height rows (e.g. wrapped cell text) would require measuring
  before reuse.
- No autocomplete keeps scope on the plan; adding
  `@codemirror/autocomplete` later is an additive extension.
- Cancel is a worker restart, so it also rolls back an open transaction —
  surfaced through the same restart notice, keeping one mental model for
  "the connection died" (ADR-004).
