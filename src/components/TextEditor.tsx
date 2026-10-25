import { forwardRef, lazy, Suspense } from "react";
import type { TextEditorHandle, TextEditorProps } from "./CodeMirrorTextEditor";

const CodeMirrorTextEditor = lazy(() => import("./CodeMirrorTextEditor").then((module) => ({ default: module.TextEditor })));

export type { TextEditorHandle } from "./CodeMirrorTextEditor";

export const TextEditor = forwardRef<TextEditorHandle, TextEditorProps>(function TextEditor(props, ref) {
  return (
    <Suspense fallback={<div className={props.size === "prompt" ? "min-h-48" : "min-h-24"} aria-busy="true" />}>
      <CodeMirrorTextEditor {...props} ref={ref} />
    </Suspense>
  );
});
