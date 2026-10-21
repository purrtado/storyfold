import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";

// Radix sheet for the navigation drawer and the narrow-screen campaign panel. Without a
// Dialog.Trigger, focus restoration to the opener is handled here.
export function Sheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
}) {
  const openerRef = useRef<HTMLElement | null>(null);
  if (props.open && openerRef.current === null) {
    openerRef.current = document.activeElement as HTMLElement | null;
  }

  return (
    <DialogPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && (
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="backdrop fixed inset-0 z-30 bg-black/40" />
          <DialogPrimitive.Content
            className={props.className ?? "drawer fixed inset-bs-0 inset-be-0 start-0 z-40 w-72 border-e border-border bg-surface"}
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              openerRef.current?.focus();
              openerRef.current = null;
            }}
          >
            <DialogPrimitive.Title className="sr-only">
              {props.title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label={props.closeLabel ?? "Close sidebar"}
              className="pressable absolute inset-bs-2 end-2 z-10 inline-flex size-11 items-center justify-center rounded-lg text-muted transition-colors active:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <CloseIcon />
            </DialogPrimitive.Close>
            {props.children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  );
}
