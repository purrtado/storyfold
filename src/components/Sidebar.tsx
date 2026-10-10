import type { Conversation } from "../lib/types";
import { FoldIcon, PanelIcon, PlusIcon } from "./icons";
import { ThemeButton } from "./ThemeToggle";
import { Tooltip } from "./Tooltip";

function conversationGroup(createdAt: number): string {
  const days = (Date.now() - createdAt) / 86_400_000;
  if (days < 1) return "Today";
  if (days < 7) return "Previous 7 days";
  return "Older";
}

function relativeDate(createdAt: number): string {
  return new Date(createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function Sidebar(props: {
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  preference: "system" | "light" | "dark";
  onPreferenceChange: (preference: "system" | "light" | "dark") => void;
  onCollapse?: () => void;
  variant?: "full" | "rail";
}) {
  const rail = props.variant === "rail";

  if (rail) {
    return (
      <div className="flex h-full [inline-size:3.5rem] flex-col items-center gap-1 py-3">
        <Tooltip content="Storyfold" side="right">
          <a href="/" className="rail-btn" aria-label="Storyfold home">
            <FoldIcon className="size-5 text-accent" />
          </a>
        </Tooltip>

        <Tooltip content="Expand sidebar" side="right">
          <button
            type="button"
            className="rail-btn"
            onClick={props.onCollapse}
            aria-label="Expand sidebar"
          >
            <PanelIcon />
          </button>
        </Tooltip>

        <Tooltip content="New conversation" side="right">
          <button
            type="button"
            className="rail-btn rail-btn--primary"
            onClick={props.onNew}
            aria-label="New conversation"
          >
            <PlusIcon />
          </button>
        </Tooltip>

        <div className="[margin-block-start:auto]">
          <ThemeButton
            preference={props.preference}
            onPreferenceChange={props.onPreferenceChange}
            compact
          />
        </div>
      </div>
    );
  }

  const groups = ["Today", "Previous 7 days", "Older"].map((label) => ({
    label,
    items: props.conversations.filter(
      (c) => conversationGroup(c.createdAt) === label,
    ),
  }));

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <a
          href="/"
          className="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 font-semibold tracking-tight no-underline"
          aria-label="Storyfold home"
        >
          <FoldIcon className="size-5 text-accent" />
          <span className="text-foreground text-base">Storyfold</span>
        </a>
        {props.onCollapse && (
          <Tooltip content="Collapse sidebar">
            <button
              type="button"
              className="pressable inline-flex size-11 cursor-pointer items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              onClick={props.onCollapse}
              aria-label="Collapse sidebar"
            >
              <PanelIcon />
            </button>
          </Tooltip>
        )}
      </div>

      <button
        type="button"
        className="pressable inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg"
        onClick={props.onNew}
      >
        <PlusIcon className="size-4" />
        New conversation
      </button>

      <nav
        aria-label="Recent conversations"
        className="chat-scroll -mx-1 flex min-block-size-0 flex-col gap-3 px-1"
      >
        {groups.map(
          (group) =>
            group.items.length > 0 && (
              <section key={group.label}>
                <h2 className="px-2 pbe-1 text-xs font-medium tracking-wide text-muted uppercase">
                  {group.label}
                </h2>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((c) => {
                    const active = c.id === props.activeId;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          aria-current={active || undefined}
                          className={`w-full cursor-pointer rounded-lg px-2 py-1.5 text-start text-sm ${
                            active
                              ? "bg-accent-soft font-medium text-foreground"
                              : "text-muted hover:bg-raised hover:text-foreground"
                          }`}
                          onClick={() => props.onSelect(c.id)}
                        >
                          <span className="line-clamp-1">{c.title}</span>
                          <span className="block text-xs opacity-70">
                            {relativeDate(c.createdAt)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ),
        )}
      </nav>

      <div className="flex flex-col gap-2">
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">
          No AI connection yet — conversations stay on this device.
        </p>
        <ThemeButton
          preference={props.preference}
          onPreferenceChange={props.onPreferenceChange}
        />
      </div>
    </div>
  );
}
