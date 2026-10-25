import { lazy, Suspense, useCallback, useImperativeHandle, useRef, type Ref, type RefObject } from "react";
import { cn } from "../lib/utils";
import "./text-editor.css";

export interface TextEditorHandle {
  focus: () => void;
  /** Replaces the selection with `text` and focuses the editor. */
  insert: (text: string) => void;
}

export interface TextEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Id of the visible label; contenteditable can't be the target of `<label htmlFor>`. */
  labelledBy?: string;
  label?: string;
  /** Style markdown syntax (emphasis, headings, code) and wrap selections typed over with `*` or `_`. */
  markdown?: boolean;
  /** Names usable as `{{name}}`: known ones are highlighted, unknown ones flagged, and `{{` offers completions. */
  placeholders?: readonly string[];
  autoFocus?: boolean;
  className?: string;
  /** Hands the document, selection and undo history from one editor instance to the next one mounted with the same ref. */
  stateRef?: RefObject<unknown>;
  ref?: Ref<TextEditorHandle>;
}

const TextEditorView = lazy(() => import("./TextEditorView"));

/** For a dialog's `onEscapeKeyDown`: Escape in an editor's find panel closes the panel, not the dialog. */
export function keepEscapeInFindPanel(event: KeyboardEvent) {
  if (event.target instanceof Element && event.target.closest(".cm-panel")) event.preventDefault();
}

/** Plain-text editor with find/replace, bracket pairing and undo history; CodeMirror loads on first use. */
export function TextEditor({ ref, ...props }: TextEditorProps) {
  const viewHandle = useRef<TextEditorHandle | null>(null);
  // Placeholder buttons are usable while the editor chunk is still loading.
  const pendingInserts = useRef<string[]>([]);
  const setViewHandle = useCallback((handle: TextEditorHandle | null) => {
    viewHandle.current = handle;
    if (!handle) return;
    for (const text of pendingInserts.current.splice(0)) handle.insert(text);
  }, []);
  useImperativeHandle(ref, () => ({
    focus: () => viewHandle.current?.focus(),
    insert: (text) => {
      if (viewHandle.current) viewHandle.current.insert(text);
      else pendingInserts.current.push(text);
    },
  }), []);

  return (
    <Suspense fallback={<div className={cn("text-editor", props.className)} aria-busy="true" />}>
      <TextEditorView {...props} ref={setViewHandle} />
    </Suspense>
  );
}
