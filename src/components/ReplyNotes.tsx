import { useLayoutEffect, useRef } from "react";
import { Brain, ChevronRight } from "lucide-react";

export function PendingDots(props: { label: string }) {
  return (
    <p className="flex items-center gap-1 py-1" role="status" aria-label={props.label}>
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="size-1.5 motion-safe:animate-pulse rounded-full bg-muted" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </p>
  );
}

function thoughtLabel(thinking: boolean, ms: number | null | undefined): string {
  if (thinking) return "Thinking…";
  if (ms === null || ms === undefined) return "Thought";
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Thought for ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}`;
}

/** Collapsed like the other notes above a reply; the body lines up under the label, its rule under the icon. */
export function ThinkingDisclosure(props: { reasoning: string; thinking: boolean; ms: number | null | undefined }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [props.reasoning]);
  return (
    <details
      className="group/thought mbs-0 mbe-2 text-xs leading-5 text-muted"
      onToggle={() => {
        const element = textRef.current;
        if (element && pinned.current && props.thinking) element.scrollTop = element.scrollHeight;
      }}
    >
      <summary className="flex w-fit cursor-pointer list-none select-none items-start gap-1.5 [&::-webkit-details-marker]:hidden [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground">
        <Brain className="mbs-0.5 size-3.5 flex-none" aria-hidden="true" />
        <span>{thoughtLabel(props.thinking, props.ms)}</span>
        <ChevronRight className="mbs-0.5 size-3.5 flex-none group-open/thought:rotate-90 motion-safe:transition-transform" aria-hidden="true" />
      </summary>
      <p
        ref={textRef}
        className="mbs-1 mbe-0 ms-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap border-s-2 border-border ps-3"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
        }}
      >
        {props.reasoning}
      </p>
    </details>
  );
}
