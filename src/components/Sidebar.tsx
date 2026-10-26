import { Globe2, MessageSquare } from "lucide-react";
import { NavLink, Link } from "react-router-dom";
import { FoldIcon, PanelIcon } from "./icons";
import { refreshChats, useChats, useWorlds } from "../lib/libraryCache";
import { Tooltip } from "./Tooltip";
import { UserMenu } from "./UserMenu";


export function RailExpand({ onCollapse }: { onCollapse?: () => void }) {
  return (
    <Tooltip content="Expand sidebar" side="right">
      <button
        type="button"
        className="rail-btn rail-expand"
        onClick={onCollapse}
        aria-label="Expand sidebar"
        aria-expanded={false}
      >
        <FoldIcon className="rail-expand-logo size-5 text-accent" aria-hidden="true" />
        <PanelIcon className="rail-expand-glyph" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

export function SidebarBrand({ onCollapse }: { onCollapse?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Link
        to="/"
        className="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 font-semibold tracking-tight no-underline"
        aria-label="Storyfold home"
      >
        <FoldIcon className="size-5 text-accent" />
        <span className="text-foreground text-base">Storyfold</span>
      </Link>
      {onCollapse && (
        <Tooltip content="Collapse sidebar">
          <button
            type="button"
            className="pressable inline-flex size-11 cursor-pointer items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
          >
            <PanelIcon />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export function Sidebar(props: {
  activeChatId?: string | null;
  onCollapse?: () => void;
  variant?: "full" | "rail";
}) {
  const chatsState = useChats();
  const worlds = useWorlds().items;

  if (props.variant === "rail") {
    return (
      <div className="flex h-full [inline-size:3.5rem] flex-col items-center gap-1 py-3">
        <RailExpand onCollapse={props.onCollapse} />
        <Tooltip content="Worlds" side="right">
          <NavLink to="/worlds" className={({ isActive }) => isActive ? "rail-btn rail-btn--active" : "rail-btn"} aria-label="Worlds">
            <Globe2 className="size-4.5" aria-hidden="true" />
          </NavLink>
        </Tooltip>
        <div className="[margin-block-start:auto]">
          <UserMenu compact />
        </div>
      </div>
    );
  }

  const chats = chatsState.items;
  const worldName = (worldId: string) => worlds?.find((world) => world.id === worldId)?.name ?? "";

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <SidebarBrand onCollapse={props.onCollapse} />
      <nav aria-label="Library" className="flex flex-col gap-0.5">
        <NavLink
          to="/worlds"
          className={({ isActive }) => `pressable flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm no-underline ${isActive ? "bg-accent-soft font-medium text-foreground" : "text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"}`}
        >
          <Globe2 className="size-4 shrink-0" aria-hidden="true" />
          Worlds
        </NavLink>
      </nav>
      <section className="flex min-block-size-0 flex-1 flex-col border-bs border-border pbs-3" aria-labelledby="chat-list-heading">
        <h2 id="chat-list-heading" className="px-2 pbe-1 text-xs font-medium tracking-wide text-muted uppercase">Recent chats</h2>
        {chats === undefined && chatsState.loadError ? (
          <div className="grid justify-items-start gap-2 px-2 py-3" role="alert">
            <p className="text-xs text-muted">{chatsState.loadError}</p>
            <button type="button" className="pressable min-h-9 rounded-lg border border-border px-2 text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={refreshChats}>Try again</button>
          </div>
        ) : chats === undefined ? (
          <p className="px-2 py-3 text-sm text-muted" role="status">Loading chats…</p>
        ) : chats.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">Chats you start in a world will appear here.</p>
        ) : (
          <nav aria-label="Chats" className="chat-scroll -mx-1 flex min-block-size-0 flex-col gap-0.5 px-1">
            {chats.map((chat) => (
              <NavLink
                key={chat.id}
                to={`/chats/${chat.id}`}
                className={({ isActive }) => `pressable w-full rounded-lg px-2 py-2 text-start text-sm no-underline ${isActive || chat.id === props.activeChatId ? "bg-accent-soft font-medium text-foreground" : "text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"}`}
              >
                <span className="flex items-start gap-2">
                  <MessageSquare className="mbs-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block line-clamp-2 leading-5">{chat.title}</span>
                    <span className="mbs-0.5 block line-clamp-1 text-xs font-normal opacity-75">{worldName(chat.world_id)}</span>
                  </span>
                </span>
              </NavLink>
            ))}
          </nav>
        )}
      </section>
      <UserMenu />
    </div>
  );
}
