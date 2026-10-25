// Adapted from beui.dev/components/motion/collapsible: controlled only, the
// trigger takes the repo's own button styling, and the `render` slot is omitted.

import { ChevronDown } from "lucide-react";
import { type HTMLMotionProps, motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { EASE_OUT, SPRING_LAYOUT } from "../lib/ease";
import { cn } from "../lib/utils";

interface CollapsibleContextValue {
  open: boolean;
  reduce: boolean;
  toggle: () => void;
  contentId: string;
  triggerId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

function useCollapsibleContext(component: string): CollapsibleContextValue {
  const context = useContext(CollapsibleContext);
  if (!context) throw new Error(`${component} must be used within <Collapsible>`);
  return context;
}

export interface CollapsibleProps extends Omit<HTMLMotionProps<"div">, "layout"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function Collapsible({ open, onOpenChange, className, children, style, ...props }: CollapsibleProps) {
  const reduce = useReducedMotion() ?? false;
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const context: CollapsibleContextValue = {
    open,
    reduce,
    toggle: () => onOpenChange(!open),
    contentId: `${id}-content`,
    triggerId: `${id}-trigger`,
    triggerRef,
  };

  return (
    <CollapsibleContext.Provider value={context}>
      <motion.div
        {...props}
        layout={!reduce}
        transition={{ layout: SPRING_LAYOUT }}
        data-state={open ? "open" : "closed"}
        className={cn("relative w-full", className)}
        style={{ ...style, originY: 0 }}
      >
        {children}
      </motion.div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({ className, children, onClick, ...props }: Omit<HTMLMotionProps<"button">, "id" | "layout">) {
  const context = useCollapsibleContext("CollapsibleTrigger");
  return (
    <motion.button
      {...props}
      ref={context.triggerRef}
      id={context.triggerId}
      type="button"
      aria-expanded={context.open}
      aria-controls={context.contentId}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.toggle();
      }}
      layout={context.reduce ? false : "position"}
      transition={{ layout: SPRING_LAYOUT }}
      className={className}
    >
      {children}
    </motion.button>
  );
}

export interface CollapsibleContentProps extends Omit<HTMLMotionProps<"div">, "id" | "layout" | "animate" | "initial"> {
  /** Padding and layout classes for the measured content, inside the clipping wrapper. */
  contentClassName?: string;
}

export function CollapsibleContent({ className, contentClassName, children, style, ...props }: CollapsibleContentProps) {
  const context = useCollapsibleContext("CollapsibleContent");
  const contentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!context.open && contentRef.current?.contains(document.activeElement)) {
      context.triggerRef.current?.focus({ preventScroll: true });
    }
  }, [context.open, context.triggerRef]);

  return (
    <motion.div
      {...props}
      ref={contentRef}
      id={context.contentId}
      role="region"
      aria-labelledby={context.triggerId}
      aria-hidden={!context.open}
      inert={!context.open}
      data-state={context.open ? "open" : "closed"}
      initial={false}
      layout={!context.reduce}
      transition={{ layout: SPRING_LAYOUT }}
      // A one-pixel closed box keeps transform projection continuous at zero.
      style={{ ...style, height: context.open ? height || "auto" : 1, originY: 0 }}
      className={cn("overflow-clip", className)}
    >
      <motion.div
        ref={innerRef}
        layout={!context.reduce}
        style={{ originY: 0 }}
        initial={false}
        animate={{ opacity: context.open ? 1 : 0 }}
        transition={{ opacity: { duration: context.open ? 0.18 : 0.12, ease: EASE_OUT }, layout: SPRING_LAYOUT }}
        className={cn("flow-root", contentClassName)}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export function CollapsibleIndicator({ className, children, ...props }: HTMLMotionProps<"span">) {
  const { open, reduce } = useCollapsibleContext("CollapsibleIndicator");
  return (
    <motion.span
      {...props}
      aria-hidden="true"
      initial={false}
      animate={{ transform: `rotate(${open ? 180 : 0}deg)` }}
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
      className={cn("ms-auto inline-flex shrink-0 items-center justify-center text-muted", className)}
    >
      {children ?? <ChevronDown className="size-4" />}
    </motion.span>
  );
}
