import { useState, type FormEvent } from "react";
import { ChevronRight, ScrollText } from "lucide-react";
import type { Chapter } from "../../shared/domain";

const buttonClasses =
  "pressable min-h-9 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised disabled:pointer-events-none disabled:opacity-50";
const primaryClasses =
  "pressable min-h-9 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50";

/**
 * Closes a chapter in the transcript: the summary the narrator gets instead
 * of the messages above it, with hand edits, a rewrite, and deletion.
 */
export function ChapterCard(props: {
  chapter: Chapter;
  number: number;
  messageCount: number;
  /** Chapters after this one, deleted with it. */
  laterCount: number;
  canAct: boolean;
  canSummarize: boolean;
  onSave: (summary: string) => Promise<void>;
  onRegenerate: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { chapter } = props;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState<"regenerate" | "delete" | null>(null);
  const [working, setWorking] = useState<"save" | "regenerate" | "delete" | null>(null);
  const disabled = !props.canAct || working !== null;

  const run = (kind: "save" | "regenerate" | "delete", action: () => Promise<void>, done: () => void) => {
    setWorking(kind);
    action().then(
      () => {
        setWorking(null);
        done();
      },
      () => setWorking(null), // the parent surfaces the error banner
    );
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    run("save", () => props.onSave(value), () => setEditing(false));
  };
  const regenerate = () => run("regenerate", props.onRegenerate, () => setConfirm(null));
  const later = props.laterCount === 0 ? "" : props.laterCount === 1 ? " and the chapter after it" : ` and the ${props.laterCount} chapters after it`;

  return (
    <section aria-label={`Chapter ${props.number} summary`} className="rounded-xl border border-border bg-surface px-4 py-3">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group/chapter">
        <summary className="flex cursor-pointer list-none select-none flex-wrap items-center gap-x-2 gap-y-1 text-sm [&::-webkit-details-marker]:hidden">
          <ScrollText className="size-4 flex-none text-accent" aria-hidden="true" />
          <span className="font-semibold">Chapter {props.number}</span>
          <span className="text-xs text-muted [font-variant-numeric:tabular-nums]">
            {props.messageCount} {props.messageCount === 1 ? "message" : "messages"} · {chapter.covered_tokens.toLocaleString()} → {chapter.summary_tokens.toLocaleString()} tokens
            {chapter.edited && " · Edited"}
          </span>
          <ChevronRight className="ms-auto size-4 flex-none text-muted group-open/chapter:rotate-90 motion-safe:transition-transform" aria-hidden="true" />
        </summary>
        <div className="mbs-3 grid gap-3">
          <p className="text-xs text-muted">The narrator gets this summary instead of the messages above it. The transcript keeps them.</p>
          {editing ? (
            <form className="grid gap-2" onSubmit={save}>
              <label className="grid gap-1 text-sm">
                Summary
                <textarea
                  className="min-h-40 rounded-lg border border-border bg-background px-3 py-2 text-[15px] leading-6 [field-sizing:content] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  required
                  autoFocus
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={primaryClasses} disabled={disabled || !value.trim()}>
                  {working === "save" ? "Saving…" : "Save"}
                </button>
                <button type="button" className={buttonClasses} onClick={() => setEditing(false)} disabled={working !== null}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <p className="whitespace-pre-wrap text-[15px] leading-6">{chapter.summary}</p>
          )}
          {!editing && confirm === null && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClasses}
                disabled={disabled}
                onClick={() => {
                  setValue(chapter.summary);
                  setEditing(true);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className={buttonClasses}
                disabled={disabled || !props.canSummarize}
                onClick={() => (chapter.edited ? setConfirm("regenerate") : regenerate())}
              >
                {working === "regenerate" ? "Summarizing…" : "Summarize again"}
              </button>
              <button type="button" className={buttonClasses} disabled={disabled} onClick={() => setConfirm("delete")}>
                Delete
              </button>
            </div>
          )}
          {confirm !== null && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={confirm === "delete" ? "Confirm deleting this chapter" : "Confirm summarizing this chapter again"}>
              <p className="min-w-0 flex-1 basis-60 text-sm text-muted">
                {confirm === "delete"
                  ? `Delete this chapter${later}? Their messages go back to the narrator; the transcript is unchanged.`
                  : "Summarize again? A new summary replaces your edits."}
              </p>
              <button
                type="button"
                className={buttonClasses}
                disabled={disabled || (confirm === "regenerate" && !props.canSummarize)}
                onClick={() => (confirm === "delete" ? run("delete", props.onDelete, () => {}) : regenerate())}
              >
                {working === "delete" ? "Deleting…" : working === "regenerate" ? "Summarizing…" : confirm === "delete" ? "Delete" : "Summarize again"}
              </button>
              <button type="button" className={buttonClasses} onClick={() => setConfirm(null)} disabled={working !== null}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
