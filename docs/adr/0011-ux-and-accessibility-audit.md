# ADR-011: UX and accessibility audit

- Status: **Accepted** (Week 9)
- Date: 2026-11-20
- Related: ADR-007 (workspace grid), ADR-010 (plan tree), plan §2, §7 Week 9,
  NFR-06, NFR-11, scenarios 21 and 22

## Context

Week 4 designed accessibility into the workspace: a CodeMirror editor with
built-in textbox semantics, an ARIA results grid with a roving tabindex and
arrow-key navigation, a transaction indicator, and live notices. Week 8 added a
`role="tree"` plan view. Week 9 is the audit that the plan schedules: axe plus a
manual keyboard/screen-reader pass, workspace polish and dark-theme checks,
empty/loading/error states, and desktop-first messaging for unsupported
browsers and viewports.

The plan's compatibility contract is explicit: Chrome/Edge/Firefox current and
Safari 17+ are supported; phones are unsupported; tablets are best effort;
≥1024 px is the supported desktop width. OPFS and Web Locks already had visible
degraded modes (in-memory banner, "multi-tab guard unavailable"), so the gate
must not replace those with a second, conflicting message.

## Decision

### Environment gate (main thread, before the worker)

- `src/shared/environment.ts` is a pure capability model. **Hard requirements**
  are WebAssembly, Web Workers, and IndexedDB; if any is missing the app cannot
  start. **Optional capabilities** are OPFS and Web Locks; their existing
  fallbacks stay in place.
- `src/app/EnvironmentGate.tsx` runs before `App` mounts. An unsupported
  browser gets a blocking `unsupported-browser` screen naming the missing
  features and the supported browser list; no worker or VFS is created, so the
  failure cannot silently lose data (scenario 22). A phone-sized viewport
  (<768 px) gets a blocking `unsupported-viewport` screen. The 768–1023 px
  tablet range renders the workspace with a persistent, non-dismissible
  `viewport-notice` (NFR-06).
- The gate reads live `window.innerWidth` and updates on resize. Capability and
  width inputs are injectable for unit tests.

### Dark theme, contrast, and focus

- The workspace was already dark; the audit found contrast failures rather than
  a missing theme. Secondary text was standardized on `text-neutral-400`
  (`text-neutral-500/600` failed 4.5:1 for small text on the dark surfaces).
  White-on-`sky-700` actions moved to `sky-800`. The CodeMirror gutter was
  lightened and the light-background `defaultHighlightStyle` was replaced with
  `oneDarkHighlightStyle`, because SQL tokens were otherwise low-contrast on
  the dark editor.
- `index.css` sets `color-scheme: dark` and a visible `:focus-visible` outline
  for every keyboard-focusable control. The results grid keeps its inset ring
  because its cells override the global outline.
- `index.html` declares `color-scheme` and `theme-color` so native controls,
  scrollbars, and the browser chrome match the theme.

### Semantics and focus management

- A "Skip to SQL workspace" link is the first tab stop and targets a `<main>`
  with `tabIndex={-1}`. The center column is `<main aria-label="SQL workspace">`
  and both side columns are named `<aside>` landmarks; the header remains the
  banner landmark.
- The side panel is a real tablist: roving tabindex, Left/Right cycling,
  Home/End, `aria-controls`, and a labelled tabpanel. The results-view switcher
  became a labelled button group (`aria-pressed` + `aria-current`) because the
  "Table" view is an active state, not a peer tab.
- Loading placeholders use `role="status"`; errors in results, plans, schema,
  table browser, history, import, and database operations use `role="alert"`.
  The application status bar is a polite live region.
- The import dialog already had `aria-modal`, an initial focus target, and
  Escape handling. It now also traps Tab/Shift+Tab inside the dialog and
  restores focus to the opener on close.
- The plan diff pairs before/after text with screen-reader-only "before:" and
  "after:" labels, so the relationship is not color-only (NFR-11).

### Testing

- `e2e/week9.spec.ts` runs `@axe-core/playwright` with the WCAG 2.2 A/AA tag
  set over the ready workspace, a results grid, history, analysis, and the
  import dialog. It also performs a keyboard-only walkthrough (skip link, Tab
  into main, grid tab stop, dialog trap, focus restore), checks landmarks and
  accessible names through role queries, verifies no page-level horizontal
  overflow at 1280 px, the tablet notice at 900 px, the phone gate at 375 px,
  and the unsupported-browser screen with WebAssembly removed.
- `EnvironmentGate.test.tsx` and `environment.test.ts` cover capability
  assessment at each boundary (all present, missing hard requirement, missing
  optional capability, viewport 1024/768/767 px).

## Findings and results

- Axe reported one remaining violation after the first pass: white text on
  `bg-sky-700` actions. Moving those actions to `bg-sky-800` cleared it. The
  audit is now **0 violations** in all five audited states.
- The CodeMirror default highlight palette was the largest manual finding: it
  is authored for light backgrounds, so keywords and comments failed contrast
  on the dark editor even though the editor container passed.
- The manual keyboard pass found no focus traps outside the dialog. It did find
  that the results-view tabs were incomplete ARIA tabs; that pattern was
  removed rather than half-implemented.
- The screen-reader pass was a semantics/accessibility-tree review (named
  landmarks, tabs, grid, editor, alerts, and status regions). A hands-on
  NVDA/VoiceOver session is still owed together with the Safari 17+ matrix run
  noted in ADR-001/002/005; nothing in this ADR claims that run has happened.
- 288 unit tests and 36 e2e tests are green on Chromium (dev and production
  preview). The axe and viewport checks are Chromium-scoped by the existing
  Playwright setup; Firefox runs the same suite with `E2E_BROWSER=firefox`.

## Alternatives considered

- **Refuse to start without OPFS**: rejected. The plan explicitly allows the
  in-memory fallback with a visible "not persistent" banner, and Week 3 already
  implemented it.
- **Refuse to start on any missing optional capability**: rejected. Losing the
  tab guard degrades multi-tab safety but does not make single-tab use unsafe;
  the existing "guard unavailable" message is the right level of warning.
- **Dismissible tablet warning**: rejected. Persisting the dismissal could hide
  a layout that is only best-effort and then break silently.
- **Rely on axe alone**: rejected. Axe cannot verify focus order, a dialog trap,
  or whether a disabled-looking layout is actually usable; the keyboard spec and
  viewport checks cover those.
- **Keep the default CodeMirror highlight style and suppress color-contrast**:
  rejected. Suppressing the rule would hide a real user-facing problem.

## Consequences

- Phones cannot open the workspace at all; that is intentional and documented.
  Tablet users can work, with an explicit warning that panels may be cramped.
- The unsupported-browser screen depends on feature detection, not user-agent
  sniffing, so a current browser with a disabled feature gets an accurate
  message.
- `@axe-core/playwright` and `@codemirror/theme-one-dark` are now dev/prod
  dependencies of `apps/web`; the axe run adds a few seconds to the Week 9 spec.
- Contrast is enforced by tests only through axe on the audited states. New
  screens must keep using the established neutral/sky tokens and should add
  themselves to the axe state list when they introduce distinct chrome.
