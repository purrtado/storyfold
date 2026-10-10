import type { ReactNode } from "react";
import { MenuIcon } from "./icons";

export function AppHeader(props: {
  title: string;
  onOpenSidebar?: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-none items-center gap-1 border-b border-border px-3 py-2">
      {props.onOpenSidebar && (
        <button
          type="button"
          className="hit-44 pressable inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-foreground md:hidden"
          onClick={props.onOpenSidebar}
          aria-label="Open sidebar"
        >
          <MenuIcon />
        </button>
      )}
      <h1 className="flex-1 truncate px-1 text-sm font-medium">{props.title}</h1>
      {props.actions}
    </header>
  );
}
