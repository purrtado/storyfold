import { useEffect, useRef } from "react";
import { SendIcon } from "./icons";

export function Composer(props: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const send = () => {
    const value = props.draft.trim();
    if (value.length === 0) return;
    props.onSend(value);
  };

  return (
    <div className="border-t border-border bg-background">
      <form
        className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pbs-3 pbe-[calc(1rem+env(safe-area-inset-bottom,0px))]"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor="composer">
          Message
        </label>
        <textarea
          id="composer"
          ref={ref}
          className="composer flex-1 rounded-xl border border-border bg-raised px-3.5 py-2.5 text-[15px] outline-offset-0 focus-visible:border-accent"
          placeholder="Write a message…"
          rows={1}
          value={props.draft}
          onChange={(e) => props.onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="submit"
          className="pressable inline-flex size-10 cursor-pointer items-center justify-center rounded-xl bg-accent text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
          disabled={props.draft.trim().length === 0}
          aria-label="Send message"
        >
          <SendIcon className="size-4" />
        </button>
      </form>
    </div>
  );
}
