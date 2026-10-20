import type { ReactNode } from "react";
import { MenuIcon } from "./icons";

export function AppHeader(props: {
  title: string;
  subtitle?: string;
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
      <h1 className="flex min-w-0 flex-1 items-baseline gap-2 px-1 text-sm font-medium">
        <span className="max-w-full flex-none truncate">{props.title}</span>
        {props.subtitle && <span className="min-w-0 truncate font-normal text-muted">{props.subtitle}</span>}
      </h1>
      {props.actions}
    </header>
  );
}
