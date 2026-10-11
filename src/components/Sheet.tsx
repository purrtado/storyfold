import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";

// shadcn-style sheet primitive backed by Radix Dialog, scoped to the one
// variant Storyfold needs: a drawer sliding in from the start edge.
// Without a Dialog.Trigger, Radix does not know the opener, so focus
// restore to it is handled here.
export function Sheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
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
            className="drawer fixed inset-bs-0 inset-be-0 start-0 z-40 w-72 border-e border-border bg-surface"
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
              className="pressable absolute end-2 top-2 inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-foreground"
              aria-label="Close sidebar"
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
