// Adapted from beUI Prompt Input — https://beui.dev/components/agents/prompt-input
// Model select and prompt actions omitted; the model comes from provider settings.
// Auto-grow uses the repo's field-sizing CSS instead of the registry's measurement mirror.
import { ArrowUp, Square } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef } from "react";
import { SPRING_PRESS } from "../lib/ease";

export interface ComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** A reply is being generated anywhere in the app; sends wait. */
  busy?: boolean;
  /** This conversation owns the running reply and shows the stop control. */
  showStop?: boolean;
  onStop?: () => void;
}

export function Composer({
  value,
  onValueChange,
  onSubmit,
  busy = false,
  showStop = false,
  onStop,
}: ComposerProps) {
  const reduce = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = Boolean(value.trim()) && !busy;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = value.trim();
    if (!prompt || busy) return;

    onSubmit(prompt);
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <div className="flex-none border-t border-border bg-background px-4 pbs-3 pbe-[calc(1rem+env(safe-area-inset-bottom,0px))]">
      <form
        onSubmit={submit}
        className="relative mx-auto w-full max-w-3xl rounded-2xl border border-border/80 bg-raised p-2 transition-colors focus-within:border-foreground/25"
      >
        <textarea
          ref={textareaRef}
          value={value}
          placeholder="Write a message…"
          aria-label="Message"
          rows={2}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="composer scrollbar-hide block w-full resize-none overflow-y-auto bg-transparent px-2 [padding-block-start:0.375rem] text-base leading-6 text-foreground outline-hidden placeholder:text-muted/55"
        />

        <div className="flex min-h-8 items-center gap-1 [margin-block-start:0.25rem]">
          {showStop ? (
            <motion.button
              type="button"
              aria-label="Stop generating"
              whileTap={reduce ? undefined : { scale: 0.97 }}
              transition={SPRING_PRESS}
              className="hit-44 ms-auto inline-flex size-9 cursor-pointer select-none items-center justify-center rounded-full border border-border bg-raised text-foreground transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
              onClick={onStop}
            >
              <Square className="size-3" fill="currentColor" aria-hidden="true" />
            </motion.button>
          ) : (
            <motion.button
              type="submit"
              disabled={!canSubmit}
              aria-label="Send message"
              whileTap={reduce ? undefined : { scale: 0.97 }}
              transition={SPRING_PRESS}
              className="hit-44 ms-auto inline-flex size-9 cursor-pointer select-none items-center justify-center rounded-full bg-accent text-accent-fg transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
            >
              <ArrowUp className="size-4" />
            </motion.button>
          )}
        </div>
      </form>
    </div>
  );
}
