// Adapted from beUI Prompt Input — https://beui.dev/components/agents/prompt-input
// Auto-grow uses the repo's field-sizing CSS instead of the registry's measurement mirror.
import { ArrowUp, Clapperboard, Square, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { SPRING_PRESS } from "../lib/ease";

export interface ComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Rendered at the start of the action row (the provider/model picker). */
  modelControl?: ReactNode;
  /** A one-reply out-of-character note; null keeps the field closed. Omit both to hide the control. */
  direction?: string | null;
  onDirectionChange?: (value: string | null) => void;
  placeholder?: string;
  inputLabel?: string;
  sendLabel?: string;
  /** A reply is being generated anywhere in the app; sends wait. */
  busy?: boolean;
  /** This session owns the running reply and shows the stop control. */
  showStop?: boolean;
  onStop?: () => void;
}

export function Composer({
  value,
  onValueChange,
  onSubmit,
  modelControl,
  direction = null,
  onDirectionChange,
  placeholder = "Write a message…",
  inputLabel = "Message",
  sendLabel = "Send message",
  busy = false,
  showStop = false,
  onStop,
}: ComposerProps) {
  const reduce = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const directionRef = useRef<HTMLInputElement>(null);
  const directionOpen = direction !== null;
  const canSubmit = Boolean(value.trim()) && !busy;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (directionOpen) directionRef.current?.focus();
  }, [directionOpen]);

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
    <div className="flex-none border-bs border-border bg-background px-4 pbs-3 pbe-[calc(1rem+env(safe-area-inset-bottom,0px))]">
      <form
        onSubmit={submit}
        className="relative mx-auto w-full max-w-3xl rounded-2xl border border-border/80 bg-raised p-2 transition-colors focus-within:border-foreground/25"
      >
        {directionOpen && onDirectionChange && (
          <div className="mbe-1 flex items-center gap-2 rounded-lg bg-surface ps-2 pe-1">
            <span className="flex-none text-xs font-medium text-muted">OOC</span>
            <input
              ref={directionRef}
              value={direction}
              onChange={(event) => onDirectionChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.defaultPrevented) {
                  event.preventDefault();
                  onDirectionChange(null);
                  textareaRef.current?.focus({ preventScroll: true });
                } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  textareaRef.current?.focus({ preventScroll: true });
                }
              }}
              placeholder="Direction for the next reply only"
              aria-label="Out-of-character direction for the next reply"
              className="composer-direction min-h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted/55"
            />
            <button
              type="button"
              aria-label="Remove direction"
              className="pressable inline-flex size-7 flex-none items-center justify-center rounded-md text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              onClick={() => {
                onDirectionChange(null);
                textareaRef.current?.focus({ preventScroll: true });
              }}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          aria-label={inputLabel}
          rows={2}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="composer scrollbar-hide block w-full resize-none overflow-y-auto bg-transparent px-2 [padding-block-start:0.375rem] text-base leading-6 text-foreground outline-hidden placeholder:text-muted/55"
        />

        <div className="flex min-h-8 items-center gap-1 [margin-block-start:0.25rem]">
          <div className="flex min-w-0 flex-1 items-center">{modelControl}</div>
          {onDirectionChange && !directionOpen && (
            <button
              type="button"
              aria-label="Direct the narrator"
              title="Direct the narrator (OOC, next reply only)"
              className="pressable hit-44 inline-flex size-8 flex-none items-center justify-center rounded-full text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              onClick={() => onDirectionChange("")}
            >
              <Clapperboard className="size-4" aria-hidden="true" />
            </button>
          )}
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
              disabled={!canSubmit}
              aria-label={sendLabel}
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
