import { protagonistOf, type Campaign } from "../../shared/domain";
import { BookOpen, Globe2, Users } from "lucide-react";
import { NavLink, Link } from "react-router-dom";
import { FoldIcon, PanelIcon, PlusIcon } from "./icons";
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
  campaigns: Campaign[];
  campaignsLoading: boolean;
  campaignsError: string;
  activeSessionId?: string | null;
  onNewCampaign: () => void;
  onRefreshCampaigns: () => void;
  onCollapse?: () => void;
  variant?: "full" | "rail";
}) {
  if (props.variant === "rail") {
    return (
      <div className="flex h-full [inline-size:3.5rem] flex-col items-center gap-1 py-3">
        <RailExpand onCollapse={props.onCollapse} />
        <Tooltip content="New campaign" side="right">
          <button type="button" className="rail-btn rail-btn--primary" onClick={props.onNewCampaign} aria-label="New campaign">
            <PlusIcon />
          </button>
        </Tooltip>
        <Tooltip content="Worlds" side="right">
          <NavLink to="/worlds" className={({ isActive }) => isActive ? "rail-btn rail-btn--active" : "rail-btn"} aria-label="Worlds">
            <Globe2 className="size-4.5" aria-hidden="true" />
          </NavLink>
        </Tooltip>
        <Tooltip content="Characters" side="right">
          <NavLink to="/characters" className={({ isActive }) => isActive ? "rail-btn rail-btn--active" : "rail-btn"} aria-label="Characters">
            <Users className="size-4.5" aria-hidden="true" />
          </NavLink>
        </Tooltip>
        <div className="[margin-block-start:auto]">
          <UserMenu compact />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <SidebarBrand onCollapse={props.onCollapse} />
      <button
        type="button"
        className="pressable inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90"
        onClick={props.onNewCampaign}
      >
        <PlusIcon className="size-4" />
        New campaign
      </button>
      <nav aria-label="Library" className="flex flex-col gap-0.5">
        <NavLink
          to="/worlds"
          className={({ isActive }) => `pressable flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm no-underline ${isActive ? "bg-accent-soft font-medium text-foreground" : "text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"}`}
        >
          <Globe2 className="size-4 shrink-0" aria-hidden="true" />
          Worlds
        </NavLink>
        <NavLink
          to="/characters"
          className={({ isActive }) => `pressable flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm no-underline ${isActive ? "bg-accent-soft font-medium text-foreground" : "text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"}`}
        >
          <Users className="size-4 shrink-0" aria-hidden="true" />
          Characters
        </NavLink>
      </nav>
      <section className="flex min-block-size-0 flex-1 flex-col border-bs border-border pbs-3" aria-labelledby="campaign-list-heading">
        <h2 id="campaign-list-heading" className="px-2 pbe-1 text-xs font-medium tracking-wide text-muted uppercase">Campaigns</h2>
        {props.campaignsError ? (
          <div className="grid justify-items-start gap-2 px-2 py-3" role="alert">
            <p className="text-xs text-muted">{props.campaignsError}</p>
            <button type="button" className="pressable min-h-9 rounded-lg border border-border px-2 text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={props.onRefreshCampaigns}>Try again</button>
          </div>
        ) : props.campaignsLoading ? (
          <p className="px-2 py-3 text-sm text-muted" role="status">Loading campaigns…</p>
        ) : props.campaigns.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">Your saved campaigns will appear here.</p>
        ) : (
          <nav aria-label="Campaigns" className="chat-scroll -mx-1 flex min-block-size-0 flex-col gap-0.5 px-1">
            {props.campaigns.map((campaign) => (
              <NavLink
                key={campaign.id}
                to={`/sessions/${campaign.active_session_id}`}
                className={({ isActive }) => `pressable w-full rounded-lg px-2 py-2 text-start text-sm no-underline ${isActive || campaign.active_session_id === props.activeSessionId ? "bg-accent-soft font-medium text-foreground" : "text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"}`}
              >
                <span className="flex items-start gap-2">
                  <BookOpen className="mbs-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block line-clamp-2 leading-5">{campaign.name}</span>
                    <span className="mbs-0.5 block line-clamp-1 text-xs font-normal opacity-75">
                      {campaign.world_snapshot.name} · {protagonistOf(campaign).name}
                    </span>
                  </span>
                </span>
              </NavLink>
            ))}
          </nav>
        )}
      </section>
      <div className="flex flex-col gap-2">
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">
          Campaigns stay on this Storyfold server.{" "}
          <Link to="/settings/providers" className="font-medium text-accent underline underline-offset-2">Add a provider</Link>
          {" "}to begin a story.
        </p>
        <UserMenu />
      </div>
    </div>
  );
}
