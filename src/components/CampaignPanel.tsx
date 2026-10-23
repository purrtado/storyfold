import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, NotebookPen, PanelRightClose, PanelRightOpen, ScrollText, Users } from "lucide-react";
import type { Campaign, Session } from "../../shared/domain";
import { worldEntryGroups } from "../lib/worldEntryGroups";
import { Avatar } from "./Avatar";
import { CampaignStateSection, CampaignTimelineSection, useCampaignSessions } from "./CampaignManagement";
import { CharacterRoster } from "./CharacterRoster";
import { Tooltip } from "./Tooltip";

const panelTabs = [
  { id: "characters", label: "Characters", Icon: Users },
  { id: "notes", label: "Notes", Icon: NotebookPen },
  { id: "campaign", label: "Campaign", Icon: ScrollText },
] as const;

type PanelTabId = (typeof panelTabs)[number]["id"];

type SessionHandoffView = { tone: "Outgoing handoff" | "Incoming handoff"; note: string; text: string };

function sessionHandoffView(session: Session, sessions: Session[]): SessionHandoffView | null {
  if (session.closed_at) {
    return session.handoff
      ? { tone: "Outgoing handoff", note: "Written when this session ended; the next session opens from it.", text: session.handoff }
      : null;
  }
  if (session.handoff) {
    return { tone: "Incoming handoff", note: "Inherited from the forked source campaign; this session opens from it.", text: session.handoff };
  }
  const index = sessions.findIndex((entry) => entry.id === session.id);
  const previous = index > 0 ? sessions[index - 1] : undefined;
  if (previous?.handoff) {
    return { tone: "Incoming handoff", note: `Carried in from “${previous.title}”.`, text: previous.handoff };
  }
  return null;
}

function CapturedDisclosure(props: { label: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 flex-none text-muted group-open:rotate-90" aria-hidden="true" />
        <span className="truncate">{props.label}</span>
      </summary>
      <div className="border-bs border-border p-3">{props.children}</div>
    </details>
  );
}

/**
 * Campaign companion panel: docked beside play on wide screens (with a collapsed
 * rail) and hosted in a sheet on narrow ones. Collapsing keeps the full panel
 * mounted so open cards, drafts, and loaded relationships survive.
 */
export function CampaignPanel(props: {
  campaign: Campaign;
  session: Session;
  active: boolean;
  canEndSession: boolean;
  onSyncSession: (sessionId: string) => Promise<void>;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const [tab, setTab] = useState<PanelTabId>("characters");
  const [mounted, setMounted] = useState<Record<PanelTabId, boolean>>({ characters: true, notes: false, campaign: false });
  const [openCharacterId, setOpenCharacterId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<PanelTabId, HTMLButtonElement | null>>>({});
  const { sessions, loading: sessionsLoading, error: sessionsError, reload: reloadSessions } = useCampaignSessions(props.campaign.id, props.session.id);
  const handoff = sessionHandoffView(props.session, sessions);
  const collapsed = Boolean(props.collapsed);

  const activate = (id: PanelTabId) => {
    if (id !== tab) scrollerRef.current?.scrollTo({ top: 0 });
    setTab(id);
    setMounted((current) => current[id] ? current : { ...current, [id]: true });
  };

  const expandTo = (id: PanelTabId, characterId?: string) => {
    activate(id);
    if (characterId) setOpenCharacterId(characterId);
    props.onCollapsedChange?.(false);
  };

  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = panelTabs.findIndex((entry) => entry.id === tab);
    const next = event.key === "ArrowRight"
      ? (index + 1) % panelTabs.length
      : event.key === "ArrowLeft"
        ? (index + panelTabs.length - 1) % panelTabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End" ? panelTabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    activate(panelTabs[next].id);
    tabRefs.current[panelTabs[next].id]?.focus();
  };

  return (
    <>
      {collapsed && (
        <div className="flex h-full [inline-size:3.5rem] flex-col items-center gap-1 py-3">
          <Tooltip content="Expand panel" side="left">
            <button type="button" className="rail-btn" onClick={() => props.onCollapsedChange?.(false)} aria-label="Expand campaign panel" aria-expanded={false}>
              <PanelRightOpen className="size-4.5" aria-hidden="true" />
            </button>
          </Tooltip>
          <div className="my-1 block-px inline-8 bg-border" />
          {props.campaign.characters.map((character) => (
            <Tooltip key={character.id} content={character.name} side="left">
              <button type="button" className="rail-btn" onClick={() => expandTo("characters", character.id)} aria-label={`Show ${character.name}`}>
                <Avatar name={character.name} imageId={character.avatar_id} className="size-8 text-xs" />
              </button>
            </Tooltip>
          ))}
          <div className="my-1 block-px inline-8 bg-border" />
          {panelTabs.slice(1).map(({ id, label, Icon }) => (
            <Tooltip key={id} content={label} side="left">
              <button type="button" className="rail-btn" onClick={() => expandTo(id)} aria-label={`Show ${label}`}>
                <Icon className="size-4.5" aria-hidden="true" />
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      <div className="flex h-full min-block-0 flex-col" hidden={collapsed}>
        <div className={`flex flex-none items-center gap-2 ps-4 pbs-3 ${props.onCollapsedChange ? "pe-2" : "pe-14"}`}>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{props.campaign.name}</h2>
            <p className="truncate text-xs text-muted">{props.session.title}{props.active ? "" : " · read-only"}</p>
          </div>
          {props.onCollapsedChange && (
            <Tooltip content="Collapse panel" side="left">
              <button type="button" className="pressable inline-flex size-11 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground" onClick={() => props.onCollapsedChange?.(true)} aria-label="Collapse campaign panel" aria-expanded>
                <PanelRightClose className="size-4.5" aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
        <div role="tablist" aria-label="Campaign panel" className="flex flex-none gap-1 border-be border-border px-2" onKeyDown={onTablistKeyDown}>
          {panelTabs.map(({ id, label, Icon }) => {
            const selected = id === tab;
            return (
              <button
                key={id}
                ref={(node) => { tabRefs.current[id] = node; }}
                type="button"
                role="tab"
                id={`campaign-tab-${id}`}
                aria-selected={selected}
                aria-controls={`campaign-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => activate(id)}
                className={`relative inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium ${selected
                  ? "text-foreground after:absolute after:inset-be-0 after:inset-is-2 after:inset-ie-2 after:block after:h-0.5 after:rounded-full after:bg-accent after:content-['']"
                  : "text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"}`}
              >
                <Icon className="size-4" aria-hidden="true" />{label}
              </button>
            );
          })}
        </div>
        <div ref={scrollerRef} className="chat-scroll flex-1 min-block-0 p-3">
          <div role="tabpanel" id="campaign-panel-characters" aria-labelledby="campaign-tab-characters" hidden={tab !== "characters"}>
            <CharacterRoster
              campaign={props.campaign}
              sessionId={props.session.id}
              openId={openCharacterId}
              onOpenChange={setOpenCharacterId}
              onSyncSession={props.onSyncSession}
            />
          </div>
          <div role="tabpanel" id="campaign-panel-notes" aria-labelledby="campaign-tab-notes" hidden={tab !== "notes"} className="[&>section]:mbs-0 [&>section]:border-0 [&>section]:pbs-0">
            {mounted.notes && <CampaignStateSection campaign={props.campaign} active={props.active} />}
          </div>
          <div role="tabpanel" id="campaign-panel-campaign" aria-labelledby="campaign-tab-campaign" hidden={tab !== "campaign"} className="[&>section:first-child]:mbs-0 [&>section:first-child]:border-0 [&>section:first-child]:pbs-0">
            {mounted.campaign && (
              <>
                <CampaignTimelineSection
                  campaign={props.campaign}
                  session={props.session}
                  active={props.active}
                  canEndSession={props.canEndSession}
                  sessions={sessions}
                  sessionsLoading={sessionsLoading}
                  sessionsError={sessionsError}
                  onReloadSessions={reloadSessions}
                  onSyncSession={props.onSyncSession}
                />
                {handoff && (
                  <section className="mbs-5 grid gap-2 rounded-xl border border-border bg-surface p-3">
                    <h3 className="text-sm font-semibold">{handoff.tone}</h3>
                    <p className="text-xs text-muted">{handoff.note}</p>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{handoff.text}</p>
                  </section>
                )}
                <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-label="Captured campaign context">
                  <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Setting</h3>
                  <CapturedDisclosure label={`World — ${props.campaign.world_snapshot.name}`}>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{props.campaign.world_snapshot.setting_brief}</p>
                  </CapturedDisclosure>
                  <CapturedDisclosure label="Starting situation">
                    <p className="whitespace-pre-wrap text-sm leading-6">{props.campaign.starting_situation || "No starting situation specified."}</p>
                  </CapturedDisclosure>
                  <CapturedDisclosure label={`Captured compendium (${props.campaign.world_snapshot.entries.length})`}>
                    <div className="grid gap-3">
                      {props.campaign.world_snapshot.entries.length === 0 ? (
                        <p className="text-sm text-muted">No compendium entries were included in this campaign.</p>
                      ) : (
                        worldEntryGroups
                          .map((group) => ({
                            ...group,
                            entries: props.campaign.world_snapshot.entries.filter((entry) => entry.kind === group.kind),
                          }))
                          .filter((group) => group.entries.length > 0)
                          .map((group) => (
                            <section key={group.kind} className="grid gap-2">
                              <h4 className="text-sm font-medium">{group.label}</h4>
                              <ul className="grid list-none gap-3 p-0">
                                {group.entries.map((entry) => (
                                  <li key={entry.id} className="grid gap-1 border-bs border-border pbs-3 first:border-0 first:pbs-0">
                                    <p className="font-medium">{entry.name}</p>
                                    <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{entry.description}</p>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          ))
                      )}
                    </div>
                  </CapturedDisclosure>
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
