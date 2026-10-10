"use client";

import { useIsPresent } from "motion/react";
import { useCallback, useState, type ReactNode } from "react";
import {
  useTooltipPosition,
  type TooltipPositionOptions,
} from "./useTooltipPosition";


/** Readiness lives with the mounted overlay, not a trigger ref's attach/detach cycle. */
export function TooltipPositioner({
  children,
  ...position
}: Omit<TooltipPositionOptions, "open" | "onPosition"> & {
  children: (ready: boolean, present: boolean) => ReactNode;
}) {
  const present = useIsPresent();
  const [ready, setReady] = useState(false);
  const onPosition = useCallback(() => setReady(true), []);
  useTooltipPosition({ ...position, open: present, onPosition });
  return (
    <span
      ref={position.floatingRef}
      inert={!present}
      aria-hidden={!present || undefined}
      className="pointer-events-none fixed [inset-inline-start:0] [inset-block-start:0] z-[9999] w-max"
      style={{ visibility: "hidden", maxWidth: "calc(100vw - 16px)" }}
    >
      {children(ready, present)}
    </span>
  );
}
