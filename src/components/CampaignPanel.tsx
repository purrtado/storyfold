import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, NotebookPen, PanelRightClose, PanelRightOpen, Plus, ScrollText, Users, X } from "lucide-react";
import { STAT_KINDS, type Campaign, type CampaignStat, type Session, type StatDefinition } from "../../shared/domain";
import { worldEntryGroups } from "../lib/worldEntryGroups";
import { createRequestEpoch } from "../lib/requestEpoch";
import {
  createCampaignStat,
  deleteCampaignStat,
  fetchStats,
  importCampaignStats,
  updateCampaignStat,
} from "../lib/storyApi";
import { Avatar } from "./Avatar";
import { CampaignStateSection, CampaignTimelineSection, useCampaignSessions } from "./CampaignManagement";
import { CharacterRoster } from "./CharacterRoster";
import { StatDefinitionEditor } from "./StatDefinitionEditor";
import { StatDefinitionList } from "./StatDefinitionList";
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** Campaign-owned stats: add, edit, and import from the bank while the story has not begun. */
export function CampaignStatsSection(props: {
  campaign: Campaign;
  sessionId: string;
  onSyncSession: (sessionId: string) => Promise<void>;
}) {
  const [requestEpoch] = useState(createRequestEpoch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ stat: CampaignStat | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const [bank, setBank] = useState<StatDefinition[] | null>(null);
  const [bankLoading, setBankLoading] = useState(false);
  const [bankError, setBankError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const sync = () => {
    void props.onSyncSession(props.sessionId).catch(() => {});
  };

  const removeStat = async (stat: CampaignStat) => {
    if (!window.confirm(`Delete “${stat.label}” from this campaign? Its values are removed from every character and relationship.`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteCampaignStat(props.campaign.id, stat.id);
      sync();
    } catch (caught) {
      setError(errorMessage(caught, "Could not delete this stat."));
    } finally {
      setBusy(false);
    }
  };

  const openPicker = async () => {
    setPicking(true);
    setBank(null);
    setBankError("");
    setSelected(new Set());
    const requestId = requestEpoch.next();
    setBankLoading(true);
    try {
      const loaded = await fetchStats();
      if (requestEpoch.isCurrent(requestId)) setBank(loaded);
    } catch (caught) {
      if (requestEpoch.isCurrent(requestId)) setBankError(errorMessage(caught, "Could not load the stat bank."));
    } finally {
      if (requestEpoch.isCurrent(requestId)) setBankLoading(false);
    }
  };

  const importable = (bank ?? []).filter((bankStat) => !props.campaign.stats.some((stat) =>
    stat.applies_to === bankStat.applies_to && stat.label.toLowerCase() === bankStat.label.toLowerCase()));

  const importSelected = async () => {
    setImporting(true);
    setError("");
    try {
      await importCampaignStats(props.campaign.id, [...selected]);
      setPicking(false);
      sync();
    } catch (caught) {
      setError(errorMessage(caught, "Could not import the selected stats."));
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-labelledby="campaign-stats-title">
      <h3 id="campaign-stats-title" className="text-xs font-semibold tracking-wide text-muted uppercase">Stats</h3>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Scales the narrator tracks for characters and relationships.</p>
        <div className="flex flex-wrap gap-2">
          {!props.campaign.story_begun && (
            <button
              type="button"
              className="pressable inline-flex min-h-10 flex-none items-center rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
              onClick={() => { void openPicker(); }}
              disabled={busy || importing}
            >
              Import from bank
            </button>
          )}
          <button
            type="button"
            className="pressable inline-flex min-h-10 flex-none items-center gap-1.5 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
            onClick={() => setEditor({ stat: null })}
            disabled={busy}
          >
            <Plus className="size-4" aria-hidden="true" />Add stat
          </button>
        </div>
      </div>
      <p className="text-xs text-muted">Edits change this campaign only — the world&apos;s stats and the shared bank are never touched.</p>

      {error && <p className="rounded-lg border border-border p-3 text-sm text-muted" role="alert">{error}</p>}
      <StatDefinitionList
        stats={props.campaign.stats}
        onEdit={(stat) => setEditor({ stat })}
        onDelete={(stat) => { void removeStat(stat); }}
        busy={busy}
      />

      {picking && (
        <div className="grid gap-3 rounded-xl border border-border bg-surface p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h4 className="font-medium">Import from the stat bank</h4>
              <p className="text-xs text-muted">Copies become this campaign&apos;s own stats and start at their defaults for every character tracking stats.</p>
            </div>
            <button
              type="button"
              className="pressable inline-flex size-9 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              onClick={() => setPicking(false)}
              disabled={importing}
              aria-label="Close the stat bank"
            ><X className="size-4" aria-hidden="true" /></button>
          </div>
          {bankError && <p className="text-sm text-muted" role="alert">{bankError}</p>}
          {bankLoading && <p className="text-sm text-muted" role="status">Loading the stat bank…</p>}
          {bank && (
            importable.length === 0 ? (
              <p className="text-sm text-muted">Every bank stat is already in this campaign.</p>
            ) : (
              <>
                {STAT_KINDS.map((kind) => {
                  const group = importable.filter((stat) => stat.applies_to === kind);
                  if (group.length === 0) return null;
                  return (
                    <div key={kind} className="grid gap-2">
                      <h5 className="text-xs font-semibold tracking-wide text-muted uppercase">{kind === "character" ? "Character stats" : "Relationship stats"}</h5>
                      <ul className="grid list-none gap-3 p-0">
                        {group.map((stat) => (
                          <li key={stat.id}>
                            <label className="flex items-start gap-3 text-sm">
                              <input
                                type="checkbox"
                                className="mbs-1 size-4 flex-none accent-accent"
                                checked={selected.has(stat.id)}
                                disabled={importing}
                                onChange={() => setSelected((current) => {
                                  const next = new Set(current);
                                  if (next.has(stat.id)) next.delete(stat.id); else next.add(stat.id);
                                  return next;
                                })}
                              />
                              <span className="grid min-w-0 flex-1 gap-0.5">
                                <span className="font-medium">{stat.label}</span>
                                <span className="text-xs text-muted">{stat.description} · {stat.min}–{stat.max}, starts at {stat.default_value}</span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="pressable min-h-11 w-fit rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90"
                  onClick={() => { void importSelected(); }}
                  disabled={selected.size === 0 || importing}
                >
                  {importing ? "Importing…" : `Import ${selected.size || ""} stat${selected.size === 1 ? "" : "s"}`.trim()}
                </button>
              </>
            )
          )}
        </div>
      )}

      {editor && (
        <StatDefinitionEditor
          stat={editor.stat}
          title={editor.stat ? `Edit ${editor.stat.label}` : "Add campaign stat"}
          description="Edits change this campaign only."
          onCreate={(input) => createCampaignStat(props.campaign.id, input)}
          onUpdate={(id, patch) => updateCampaignStat(props.campaign.id, id, patch)}
          onSaved={() => sync()}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
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
  /** Opens this character's card; a new `key` re-reveals the same character. */
  revealCharacter?: { id: string; key: number } | null;
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

  useEffect(() => {
    if (props.revealCharacter) expandTo("characters", props.revealCharacter.id);
  }, [props.revealCharacter]);

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
              revealKey={props.revealCharacter?.key}
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
                <CampaignStatsSection
                  campaign={props.campaign}
                  sessionId={props.session.id}
                  onSyncSession={props.onSyncSession}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
