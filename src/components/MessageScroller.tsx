// Adapted from beUI Message Scroller — https://beui.dev/components/agents/message-scroller
// Optional registry navigation rail omitted.
import { useReducedMotion } from "motion/react";
import {
  type ComponentPropsWithRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "../lib/utils";

export interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
  /** Keep growing output pinned while the reader remains near the end. */
  followOutput?: boolean;
  /** Distance from the end that still counts as following the output. */
  followThreshold?: number;
  /** Smoothly follow growing content. */
  smooth?: boolean;
  /** Reports when the reader leaves or returns to the live edge. */
  onFollowChange?: (following: boolean) => void;
  /** Accessible label for the scrollable transcript. */
  label?: string;
  viewportClassName?: string;
  contentClassName?: string;
}

export function MessageScroller({
  followOutput = true,
  followThreshold = 56,
  smooth = true,
  onFollowChange,
  label = "Session transcript",
  viewportClassName,
  contentClassName,
  className,
  children,
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(followOutput);
  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);

  const setFollowing = useCallback(
    (next: boolean) => {
      if (followingRef.current === next) return;
      followingRef.current = next;
      onFollowChange?.(next);
    },
    [onFollowChange],
  );

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    programmaticScrollRef.current = true;
    if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, behavior === "smooth" ? 320 : 0);
  }, []);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || programmaticScrollRef.current) return;

    const distance =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setFollowing(distance <= followThreshold);
  }, [followThreshold, setFollowing]);

  const leaveLiveEdge = useCallback(() => {
    programmaticScrollRef.current = false;
    const viewport = viewportRef.current;
    // Stop an in-flight programmatic follow at the current position so the
    // reader's wheel/touch/keys win instead of the animation dragging them.
    if (viewport && typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollTop, behavior: "instant" });
    }
  }, []);

  useLayoutEffect(() => {
    followingRef.current = followOutput;
    if (!followOutput) return;

    frameRef.current = requestAnimationFrame(() => scrollToEnd("auto"));
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [followOutput, scrollToEnd]);

  useEffect(() => {
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      if (!followOutput || !followingRef.current) return;
      // Viewport geometry changes (composer growth, drawer churn) re-align
      // instantly; content growth keeps the registry's smooth follow.
      const viewportResized = entries.some((entry) => entry.target === viewport);
      scrollToEnd(
        viewportResized || reduce || !smooth ? "auto" : "smooth",
      );
    });
    observer.observe(content);
    observer.observe(viewport);

    return () => observer.disconnect();
  }, [followOutput, reduce, scrollToEnd, smooth]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return (
    <div
      data-slot="message-scroller"
      className={cn("[min-block-size:0]", className)}
      {...props}
    >
      <section
        ref={viewportRef}
        tabIndex={0}
        aria-label={label}
        onScroll={handleScroll}
        onWheel={leaveLiveEdge}
        onTouchStart={leaveLiveEdge}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
            leaveLiveEdge();
          }
        }}
        className={cn(
          "h-full overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable]",
          viewportClassName,
        )}
      >
        <div
          ref={contentRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          className={contentClassName}
        >
          {children}
        </div>
      </section>
    </div>
  );
}
