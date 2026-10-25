import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { cn } from "../lib/utils";
import type { TextEditorProps } from "./TextEditor";

// No single quote: apostrophes in prose ("don't") would keep opening pairs.
const pairedBrackets = EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", '"'] } }]);

const markdownStyle = HighlightStyle.define([
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.heading, fontWeight: "650" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)", fontSize: "0.875em" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: [tags.processingInstruction, tags.url, tags.quote, tags.contentSeparator], color: "var(--muted)" },
]);

/** Typing `*` or `_` over a selection wraps it instead of replacing it. */
const wrapWithMarkup = EditorView.inputHandler.of((view, _from, _to, text) => {
  if ((text !== "*" && text !== "_") || view.state.selection.ranges.every((range) => range.empty)) return false;
  view.dispatch(view.state.changeByRange((range) => range.empty
    ? { changes: { from: range.from, insert: text }, range: EditorSelection.cursor(range.from + 1) }
    : {
        changes: [{ from: range.from, insert: text }, { from: range.to, insert: text }],
        range: EditorSelection.range(range.anchor + 1, range.head + 1),
      }), { scrollIntoView: true, userEvent: "input.type" });
  return true;
});

function placeholderTokens(names: readonly string[]): Extension {
  const known = new Set(names);
  const knownMark = Decoration.mark({ class: "cm-token" });
  const unknownMark = Decoration.mark({ class: "cm-token cm-token-unknown", attributes: { title: "Unknown placeholder" } });
  const decorator = new MatchDecorator({
    regexp: /\{\{(.*?)\}\}/g,
    decoration: (match) => known.has(match[1]!) ? knownMark : unknownMark,
  });
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorator.createDeco(view); }
    update(update: ViewUpdate) { this.decorations = decorator.updateDeco(update, this.decorations); }
  }, { decorations: (plugin) => plugin.decorations });
}

function placeholderCompletions(names: readonly string[]): Extension {
  const options: Completion[] = names.map((name) => ({
    label: name,
    // Bracket pairing usually already typed the closing `}}`; step over it rather than doubling it.
    apply: (view, _completion, from, to) => {
      const closed = view.state.sliceDoc(to, to + 2) === "}}";
      view.dispatch({
        changes: { from, to, insert: closed ? name : `${name}}}` },
        selection: { anchor: from + name.length + 2 },
        userEvent: "input.complete",
      });
    },
  }));
  const source = (context: CompletionContext) => {
    const match = context.matchBefore(/\{\{\w*/);
    return match ? { from: match.from + 2, options, validFor: /^\w*$/ } : null;
  };
  return autocompletion({ override: [source], icons: false });
}

export default function TextEditorView({ value, onChange, labelledBy, label, markdown, placeholders, autoFocus, className, ref }: TextEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const extensionsRef = useRef<Extension[]>([]);
  useLayoutEffect(() => { onChangeRef.current = onChange; });

  // Configuration is read once at mount; rebuilding the view would drop undo history.
  useLayoutEffect(() => {
    const attributes: Record<string, string> = { spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" };
    if (labelledBy) attributes["aria-labelledby"] = labelledBy;
    if (label) attributes["aria-label"] = label;
    extensionsRef.current = [
      history(),
      closeBrackets(),
      pairedBrackets,
      search({ top: true }),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(attributes),
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      markdown ? [markdownLanguage, syntaxHighlighting(markdownStyle), wrapWithMarkup] : [],
      placeholders ? [placeholderTokens(placeholders), placeholderCompletions(placeholders)] : [],
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const next = update.state.doc.toString();
        if (next === valueRef.current) return;
        valueRef.current = next;
        onChangeRef.current(next);
      }),
    ];
    const view = new EditorView({
      parent: parentRef.current!,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: extensionsRef.current,
        selection: autoFocus ? { anchor: valueRef.current.length } : undefined,
      }),
    });
    viewRef.current = view;
    // A frame later, so a closing menu or dialog doesn't take focus back.
    const frame = autoFocus ? requestAnimationFrame(() => view.focus()) : 0;
    return () => {
      cancelAnimationFrame(frame);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // A value set from outside (another record, a reset) is a new document: undo must not reach the old one.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === valueRef.current) return;
    valueRef.current = value;
    view.setState(EditorState.create({ doc: value, extensions: extensionsRef.current }));
  }, [value]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    insert: (text) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input" });
      view.focus();
    },
  }), []);

  return <div ref={parentRef} className={cn("text-editor", className)} />;
}
