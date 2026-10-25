import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Search } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import "./text-editor.css";

export type TextEditorHandle = {
  focus: () => void;
  insertText: (text: string) => void;
};

export type TextEditorProps = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  size?: "message" | "prompt";
};

export const TextEditor = forwardRef<TextEditorHandle, TextEditorProps>(function TextEditor(
  { ariaLabel, value, onChange, autoFocus = false, size = "message" },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    insertText: (text) => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    },
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        closeBrackets(),
        bracketMatching(),
        search(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div className={`story-editor story-editor--${size}`}>
      <div className="story-editor__tools">
        <button
          type="button"
          className="story-editor__find"
          aria-label={`Find and replace in ${ariaLabel}`}
          onClick={() => {
            if (viewRef.current) openSearchPanel(viewRef.current);
          }}
        >
          <Search className="size-3.5" aria-hidden="true" />
          Find &amp; replace
        </button>
      </div>
      <div ref={hostRef} className="story-editor__surface" />
    </div>
  );
});
