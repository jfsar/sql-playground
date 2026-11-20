import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { SQLite, sql } from "@codemirror/lang-sql";

export interface SqlSelection {
  text: string;
  from: number;
  to: number;
}

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Mod-Enter: run the selection, or the whole document when none. */
  onRun: () => void;
  /** Mod-Shift-Enter: explain the selection, or the whole document. */
  onExplain: () => void;
  /** Fires on every selection change; null when the selection is empty. */
  onSelectionChange: (selection: SqlSelection | null) => void;
  /** Range to underline as the last SQL error (cleared on edit). */
  errorMark?: { from: number; to: number } | null;
}

const setErrMark = StateEffect.define<{ from: number; to: number } | null>();

const errMarkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrMark)) {
        if (!e.value || e.value.from >= e.value.to) return Decoration.none;
        return Decoration.set([
          Decoration.mark({ class: "cm-error-mark" }).range(e.value.from, e.value.to),
        ]);
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const sqlEditorTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#0a0a0a", color: "#e5e5e5" },
    ".cm-scroller": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: "0.875rem",
      lineHeight: "1.5",
    },
    ".cm-content": { padding: "0.5rem 0", caretColor: "#fafafa" },
    ".cm-line": { padding: "0 0.75rem" },
    ".cm-gutters": {
      backgroundColor: "#0a0a0a",
      color: "#8a8a8a",
      border: "none",
      borderRight: "1px solid #262626",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#a3a3a3" },
    ".cm-activeLine": { backgroundColor: "rgba(63, 63, 70, 0.25)" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#3f3f46",
    },
    "& ::selection": { backgroundColor: "#3f3f46" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#fafafa", borderLeftWidth: "2px" },
    ".cm-error-mark": {
      backgroundColor: "rgba(248, 113, 113, 0.3)",
      textDecoration: "underline wavy #f87171",
      borderRadius: "2px",
    },
  },
  { dark: true },
);

/**
 * SQL editor (CodeMirror 6, plan §3 Epic 1 / §7 Week 4): syntax highlighting,
 * Mod-Enter run, Mod-Shift-Enter explain, selection reporting for
 * run-selection, and an error underline at the SQLite-reported offset.
 *
 * Accessibility (NFR-11): CodeMirror's built-in semantics stay on (role
 * textbox, multiline label); Tab is not bound to indent so keyboard users can
 * leave the editor; the `sql-input` testid lands on the content element, which
 * Playwright can fill like a textarea.
 */
export function SqlEditor({
  value,
  onChange,
  onRun,
  onExplain,
  onSelectionChange,
  errorMark = null,
}: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialDoc = useRef(value);
  const changeRef = useRef(onChange);
  const runRef = useRef(onRun);
  const explainRef = useRef(onExplain);
  const selectionRef = useRef(onSelectionChange);
  const lastSelectionRef = useRef<SqlSelection | null>(null);

  // Keep callbacks reachable from the view without rebuilding it every render.
  useEffect(() => {
    changeRef.current = onChange;
    runRef.current = onRun;
    explainRef.current = onExplain;
    selectionRef.current = onSelectionChange;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          // A dark-background highlight style: the default palette is built for
          // light surfaces and fails contrast on the dark editor (Week 9 audit).
          syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          sql({ dialect: SQLite }),
          errMarkField,
          sqlEditorTheme,
          keymap.of([
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                runRef.current();
                return true;
              },
            },
            {
              key: "Mod-Shift-Enter",
              preventDefault: true,
              run: () => {
                explainRef.current();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
          ]),
          EditorView.contentAttributes.of({
            "data-testid": "sql-input",
            "aria-label": "SQL editor",
            "aria-keyshortcuts": "Control+Enter Meta+Enter",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              changeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const main = update.state.selection.main;
              const next: SqlSelection | null = main.empty
                ? null
                : {
                    text: update.state.sliceDoc(main.from, main.to),
                    from: main.from,
                    to: main.to,
                  };
              const prev = lastSelectionRef.current;
              const same =
                prev === null
                  ? next === null
                  : next !== null &&
                    prev.from === next.from &&
                    prev.to === next.to &&
                    prev.text === next.text;
              if (!same) {
                lastSelectionRef.current = next;
                selectionRef.current(next);
              }
            }
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // External value changes (the component owns edits via onChange otherwise).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setErrMark.of(errorMark) });
  }, [errorMark]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
}
