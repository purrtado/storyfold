"use client";

import { AnimatePresence } from "motion/react";
import { TooltipPositioner } from "./TooltipPositioner";
import { useTooltipPointer } from "./useTooltipPosition";
import {
  cloneElement,
  isValidElement,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { TooltipSurface } from "./TooltipSurface";
import { useDismiss } from "./TooltipDismiss";
import { useHoverGesture } from "./useHoverGesture";
import { useTapGesture } from "./useTapGesture";
import { cn } from "../lib/utils";

type Side = "top" | "right" | "bottom" | "left";

export interface TooltipProps {
  content: ReactNode;
  children?: ReactElement;
  anchorRef?: RefObject<HTMLElement | SVGElement | null>;
  anchorPoint?: { x: number; y: number };
  followCursor?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  side?: Side;
  delay?: number;
  className?: string;
  wrapperClassName?: string;
}

const WARM_WINDOW_MS = 300;
let lastHiddenAt = 0;

export function Tooltip({
  content,
  children,
  side = "top",
  delay = 120,
  className,
  wrapperClassName,
  anchorRef: externalAnchorRef,
  anchorPoint,
  followCursor = false,
  open: controlledOpen,
  onOpenChange,
  id: providedId,
}: TooltipProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const timer = useRef<number | undefined>(undefined);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const anchor = externalAnchorRef ?? wrapperRef;
  const hover = useHoverGesture();
  const floatingRef = useRef<HTMLSpanElement | null>(null);
  const pointer = useTooltipPointer(anchor, followCursor);
  const focused = useRef(false);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    if (open) return;
    if (Date.now() - lastHiddenAt < WARM_WINDOW_MS) {
      setOpen(true);
      return;
    }
    timer.current = window.setTimeout(() => setOpen(true), delay);
  }, [delay, setOpen, open]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (open) lastHiddenAt = Date.now();
    setOpen(false);
  }, [open, setOpen]);

  const leave = useCallback(() => {
    if (focused.current) return;
    window.clearTimeout(timer.current);
    if (followCursor) hide();
    else timer.current = window.setTimeout(hide, 100);
  }, [followCursor, hide]);
  const insideTooltip = useCallback(
    (target: Element) => Boolean(floatingRef.current?.contains(target)),
    [],
  );

  const tap = useTapGesture<boolean>();
  const toggleOnTap = useCallback(() => {
    const gesture = tap.take();
    if (!gesture || gesture.pointerType === "mouse") return;
    if (gesture.state) {
      hide();
      return;
    }
    window.clearTimeout(timer.current);
    setOpen(true);
  }, [hide, tap, setOpen]);

  useDismiss(open, hide, anchor, { ignore: insideTooltip });

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  if (!externalAnchorRef && !isValidElement(children)) return children;

  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "aria-describedby":
          [(children.props as Record<string, unknown>)["aria-describedby"], open ? id : undefined]
            .filter(Boolean)
            .join(" ") || undefined,
      })
    : null;

  return (
    <>
      {!externalAnchorRef ? (
        <span
          ref={wrapperRef}
          className={cn("relative inline-flex align-middle", wrapperClassName)}
          onPointerEnter={(event: PointerEvent) => {
            if (hover.enter(event)) show();
          }}
          onPointerLeave={(event: PointerEvent) => {
            if (hover.leave(event)) leave();
          }}
          onFocus={() => {
            focused.current = true;
            show();
          }}
          onBlur={() => {
            focused.current = false;
            hide();
          }}
          onPointerDown={(event: PointerEvent) => tap.start(event, open)}
          onPointerCancel={tap.drop}
          onKeyDown={(event) => {
            tap.drop();
            if (event.key === "Escape") hide();
          }}
          onClick={toggleOnTap}
        >
          {trigger}
        </span>
      ) : null}
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <TooltipPositioner
                  key="tooltip"
                  anchorRef={anchor}
                  floatingRef={floatingRef}
                  anchorPoint={anchorPoint}
                  followCursor={followCursor}
                  side={side}
                  onDismiss={hide}
                  pointer={pointer}
                >
                  {(positioned, isPresent) => (
                    <TooltipSurface
                      id={id}
                      ready={positioned}
                      side={side}
                      onPointerEnter={() => {
                        window.clearTimeout(timer.current);
                      }}
                      onPointerLeave={leave}
                      style={{
                        maxWidth: "calc(100vw - 16px)",
                        whiteSpace: "normal",
                        pointerEvents: isPresent && !followCursor ? "auto" : "none",
                      }}
                      className={cn("overflow-hidden", className)}
                    >
                      {content}
                    </TooltipSurface>
                  )}
                </TooltipPositioner>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
