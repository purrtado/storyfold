import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChevronRight, SlidersHorizontal, Sparkles, X } from "lucide-react";
import type { Campaign, CharacterSnapshot, Message, Session } from "../../shared/domain";
import { fetchProvider, type ProviderConfig } from "../lib/provider";
import type { Generation } from "../lib/useChatGeneration";
import { Markdown } from "./Markdown";
import { AppHeader } from "./AppHeader";
import { Composer } from "./Composer";
import { MessageScroller } from "./MessageScroller";
import { Sheet } from "./Sheet";
import { CampaignStateSection, CampaignTimelineSection, useCampaignSessions } from "./CampaignManagement";
import { RelationshipManagement } from "./RelationshipManagement";
import { worldEntryGroups } from "../lib/worldEntryGroups";
import { isActiveCampaignSession } from "../lib/campaignLifecycle";

function PendingDots() {
  return (
    <p className="flex items-center gap-1 py-1" role="status" aria-label="Narration is in progress">
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="size-1.5 motion-safe:animate-pulse rounded-full bg-muted" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </p>
  );
}

function MessageRow(props: {
  message: Message;
  liveText?: string;
  streaming?: boolean;
}) {
  const { message } = props;
  const isDraft = message.status !== "complete";
  const status = message.status === "pending"
    ? "Draft · Generating"
    : message.status === "interrupted"
      ? "Draft · Interrupted"
      : message.status === "failed"
        ? "Draft · Failed"
        : "";
  const content = props.liveText ?? message.content;

  if (message.role === "user") {
    return (
      <article className="flex justify-end">
        <div className="max-w-[90%] rounded-2xl rounded-ee-md bg-accent-soft px-4 py-3 text-foreground">
          <p className="mbs-0 mbe-2 text-xs font-medium text-muted">{message.speaker_name}</p>
          <p className="whitespace-pre-wrap text-[15px] leading-6">{message.content}</p>
        </div>
      </article>
    );
  }

  return (
    <article className={`rounded-xl ${isDraft ? "border border-dashed border-border bg-surface p-4" : ""}`}>
      <div className="mbs-0 mbe-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4 text-accent" aria-hidden="true" />
        <span>{message.speaker_name}</span>
        {isDraft && <span className="text-xs font-normal text-muted">{status}</span>}
      </div>
      {content ? <Markdown content={content} streaming={props.streaming} /> : message.status === "pending" ? <PendingDots /> : null}
    </article>
  );
}

const characterSnapshotFields = [
  ["appearance", "Appearance"],
  ["personality", "Personality"],
  ["background", "Background"],
  ["baseline_motivations", "Baseline motivations"],
  ["speaking_style", "Speaking style"],
] as const;

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

function SnapshotDetails(props: { summary: string; character: CharacterSnapshot }) {
  return (
    <CapturedDisclosure label={props.summary}>
      <div className="grid gap-2">
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{props.character.description}</p>
        {characterSnapshotFields.filter(([field]) => props.character[field]).map(([field, label]) => (
          <p key={field} className="whitespace-pre-wrap text-sm leading-6 text-muted">
            <span className="font-medium text-foreground">{label}:</span> {props.character[field]}
          </p>
        ))}
        {props.character.world_context && (
          <p className="whitespace-pre-wrap text-sm leading-6 text-muted">
            <span className="font-medium text-foreground">World-specific context:</span> {props.character.world_context}
          </p>
        )}
      </div>
    </CapturedDisclosure>
  );
}

const campaignTabs = [
  { id: "session", label: "Session" },
  { id: "state", label: "State" },
  { id: "relationships", label: "Relationships" },
  { id: "timeline", label: "Timeline" },
] as const;

type CampaignTabId = (typeof campaignTabs)[number]["id"];

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

function CampaignDetailsSheet(props: {
  campaign: Campaign;
  session: Session;
  active: boolean;
  canEndSession: boolean;
  onSyncSession: (sessionId: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<CampaignTabId>("session");
  const [mounted, setMounted] = useState<Record<CampaignTabId, boolean>>({ session: true, state: false, relationships: false, timeline: false });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<CampaignTabId, HTMLButtonElement | null>>>({});
  const { sessions, loading: sessionsLoading, error: sessionsError, reload: reloadSessions } = useCampaignSessions(props.campaign.id, props.session.id);
  const handoff = sessionHandoffView(props.session, sessions);

  const activate = (id: CampaignTabId) => {
    setTab(id);
    setMounted((current) => current[id] ? current : { ...current, [id]: true });
    scrollerRef.current?.scrollTo({ top: 0 });
  };

  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = campaignTabs.findIndex((entry) => entry.id === tab);
    const next = event.key === "ArrowRight"
      ? (index + 1) % campaignTabs.length
      : event.key === "ArrowLeft"
        ? (index + campaignTabs.length - 1) % campaignTabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End" ? campaignTabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    activate(campaignTabs[next].id);
    tabRefs.current[campaignTabs[next].id]?.focus();
  };

  const tablist = campaignTabs.map((entry) => {
    const selected = entry.id === tab;
    return (
      <button
        key={entry.id}
        ref={(node) => { tabRefs.current[entry.id] = node; }}
        type="button"
        role="tab"
        id={`campaign-tab-${entry.id}`}
        aria-selected={selected}
        aria-controls={`campaign-panel-${entry.id}`}
        tabIndex={selected ? 0 : -1}
        onClick={() => activate(entry.id)}
        className={`pressable relative min-h-11 flex-none rounded-lg px-3 text-sm font-medium ${selected
          ? "text-foreground after:absolute after:inset-be-0 after:inset-is-2 after:inset-ie-2 after:block after:h-0.5 after:rounded-full after:bg-accent after:content-['']"
          : "text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"}`}
      >
        {entry.label}
      </button>
    );
  });

  return (
    <div className="flex h-full min-block-size-0 flex-col">
      <div className="flex-none border-bs border-border p-5 pe-14">
        <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Your context</p>
        <h2 className="mbs-1 text-xl font-semibold">{props.campaign.name}</h2>
      </div>
      <div role="tablist" aria-label="Campaign details" className="flex overflow-x-auto flex-none px-3 [justify-content:safe_center]" onKeyDown={onTablistKeyDown}>
        {tablist}
      </div>
      <div ref={scrollerRef} className="chat-scroll p-5">
        <div role="tabpanel" id="campaign-panel-session" aria-labelledby="campaign-tab-session" hidden={tab !== "session"} tabIndex={0}>
          <section className="grid gap-2 border-bs border-border pbs-4">
            <p className="text-xs font-medium text-muted">{props.active ? "Current session" : "Archived session"}</p>
            <h3 className="font-semibold">{props.session.title}</h3>
          </section>
          {handoff && (
            <section className="mbs-5 grid gap-2 rounded-xl border border-border bg-surface p-3">
              <h4 className="text-sm font-semibold">{handoff.tone}</h4>
              <p className="text-xs text-muted">{handoff.note}</p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{handoff.text}</p>
            </section>
          )}
          <section className="mbs-5 grid gap-1 border-bs border-border pbs-4 text-sm" aria-label="Captured campaign names">
            <p><span className="font-medium">World:</span> <span className="text-muted">{props.campaign.world_snapshot.name}</span></p>
            <p><span className="font-medium">Playing as:</span> <span className="text-muted">{props.campaign.protagonist_snapshot.name}</span></p>
            <p><span className="font-medium">Cast:</span> <span className="text-muted">{props.campaign.cast.map((character) => character.name).join(", ") || "None"}</span></p>
          </section>
          <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-label="Captured campaign context">
            <CapturedDisclosure label={`World — ${props.campaign.world_snapshot.name}`}>
              <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{props.campaign.world_snapshot.setting_brief}</p>
            </CapturedDisclosure>
            <SnapshotDetails summary={`Playing as — ${props.campaign.protagonist_snapshot.name}`} character={props.campaign.protagonist_snapshot} />
            {props.campaign.cast.map((character) => (
              <SnapshotDetails key={character.id} summary={character.name} character={character} />
            ))}
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
        </div>
        {mounted.state && (
          <div role="tabpanel" id="campaign-panel-state" aria-labelledby="campaign-tab-state" hidden={tab !== "state"} tabIndex={0}>
            <CampaignStateSection campaign={props.campaign} active={props.active} />
          </div>
        )}
        {mounted.relationships && (
          <div role="tabpanel" id="campaign-panel-relationships" aria-labelledby="campaign-tab-relationships" hidden={tab !== "relationships"} tabIndex={0}>
            <RelationshipManagement campaign={props.campaign} sessions={sessions} />
          </div>
        )}
        {mounted.timeline && (
          <div role="tabpanel" id="campaign-panel-timeline" aria-labelledby="campaign-tab-timeline" hidden={tab !== "timeline"} tabIndex={0}>
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
          </div>
        )}
      </div>
    </div>
  );
}

export function CampaignPlay(props: {
  sessionId: string;
  campaign: Campaign | null;
  session: Session | null;
  sessionLoading: boolean;
  sessionError: string;
  messages: Message[] | undefined;
  messagesLoading: boolean;
  messagesError: string;
  generation: Generation | null;
  draft: string;
  selectedModel: string;
  onOpenSidebar: () => void;
  onDraftChange: (sessionId: string, value: string) => void;
  onModelChange: (sessionId: string, model: string) => void;
  onSend: (sessionId: string, value: string, model?: string) => void;
  onOpen: (sessionId: string, model?: string) => boolean;
  onRetryOpening: (sessionId: string, model?: string) => boolean;
  onStop: (sessionId: string) => void | Promise<void>;
  onRefreshMessages: (sessionId: string) => void | Promise<void>;
  onRetrySession: (sessionId: string) => void | Promise<void>;
  onDismissGeneration: () => void;
  onSyncSession: (sessionId: string) => Promise<void>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [modelCatalogState, setModelCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const messages = props.messages ?? [];
  const live = props.generation?.sessionId === props.sessionId ? props.generation : null;
  const otherGeneration = props.generation && props.generation.sessionId !== props.sessionId && props.generation.phase !== "error"
    ? props.generation
    : null;
  const otherGenerationError = props.generation
    && props.generation.sessionId !== props.sessionId
    && props.generation.phase === "error"
    ? props.generation
    : null;
  const selectedModel = modelCatalogState === "ready"
    && props.selectedModel
    && props.selectedModel !== provider?.model
    && provider?.models.some((model) => model.id === props.selectedModel)
    ? props.selectedModel
    : "";
  const isActiveSession = Boolean(
    props.campaign
    && props.session
    && isActiveCampaignSession(props.campaign, props.session),
  );
  const hasPending = messages.some((message) => message.role === "assistant" && message.status === "pending")
    || Boolean(live?.pendingMessageId && live.phase !== "error");
  const hasCompletedNarration = messages.some((message) => message.role === "assistant" && message.status === "complete");
  const canRetryOpening = isActiveSession
    && !hasCompletedNarration
    && messages.some((message) => message.role === "assistant" && (message.status === "failed" || message.status === "interrupted"));
  const transcriptReady = props.messages !== undefined && !props.messagesLoading && !props.messagesError;
  const busy = !transcriptReady || hasPending || live?.phase === "streaming" || live?.phase === "stopping" || Boolean(otherGeneration) || modelCatalogState === "loading";
  const showEmptyOpening = isActiveSession && messages.length === 0 && !busy && (!live || live.phase === "error");

  useEffect(() => {
    let active = true;
    fetchProvider().then(
      (loaded) => {
        if (!active) return;
        setProvider(loaded);
        setModelCatalogState("ready");
      },
      () => {
        if (active) setModelCatalogState("error");
      },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (modelCatalogState === "ready" && props.selectedModel && props.selectedModel === provider?.model) {
      props.onModelChange(props.sessionId, "");
    }
  }, [modelCatalogState, props.onModelChange, props.selectedModel, props.sessionId, provider?.model]);

  useEffect(() => {
    setFollowing(true);
  }, [props.sessionId]);

  useEffect(() => {
    if (!hasPending) return;
    const refresh = () => { void props.onRefreshMessages(props.sessionId); };
    const interval = window.setInterval(refresh, 3000);
    return () => window.clearInterval(interval);
  }, [hasPending, props.onRefreshMessages, props.sessionId]);

  useEffect(() => {
    if (!isActiveSession || props.sessionLoading || props.sessionError || !props.session || !transcriptReady || modelCatalogState === "loading") return;
    if (messages.length !== 0) return;
    props.onOpen(props.sessionId, selectedModel || undefined);
  }, [isActiveSession, messages.length, modelCatalogState, props.generation?.phase, props.generation?.sessionId, props.onOpen, props.session, props.sessionError, props.sessionId, props.sessionLoading, selectedModel, transcriptReady]);

  const handleSend = (value: string) => {
    setFollowing(true);
    props.onSend(props.sessionId, value, selectedModel || undefined);
  };
  const unmatchedLive = live?.pendingMessageId
    ? !messages.some((message) => message.id === live.pendingMessageId)
    : false;

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader
        title={props.campaign?.name ?? "Campaign"}
        onOpenSidebar={props.onOpenSidebar}
        actions={props.campaign && <button type="button" className="pressable inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground" onClick={() => setDetailsOpen(true)}><SlidersHorizontal className="size-4" aria-hidden="true" />Details</button>}
      />

      {props.sessionLoading ? (
        <p className="flex-1 px-4 py-8 text-sm text-muted" role="status">Loading campaign…</p>
      ) : props.sessionError || !props.campaign || !props.session ? (
        <section className="m-4 grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
          <p className="text-sm text-muted">{props.sessionError || "This campaign session could not be loaded."}</p>
          <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void props.onRetrySession(props.sessionId); }}>Try again</button>
        </section>
      ) : (
        <>
          <header className="flex flex-none flex-wrap items-start justify-between gap-4 border-bs border-border px-4 py-4 [padding-inline:clamp(1rem,0.75rem+1vw,2rem)]">
            <div className="min-w-0">
              <nav aria-label="Breadcrumb" className="mbs-0 mbe-3 flex flex-wrap items-center gap-2 text-sm text-muted">
                <Link to="/worlds" className="text-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground">Worlds</Link>
                <ChevronRight className="size-3.5" aria-hidden="true" />
                <Link to={`/sessions/${encodeURIComponent(props.campaign.active_session_id)}`} className="text-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground">{props.campaign.name}</Link>
                <ChevronRight className="size-3.5" aria-hidden="true" />
                <span aria-current="page">{props.session.title}</span>
              </nav>
              <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">{isActiveSession ? "Active session" : "Read-only session"}</p>
              <h1 className="mbs-1 text-xl font-semibold tracking-tight">{props.session.title}</h1>
              <div className="mbs-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                <span>{props.campaign.world_snapshot.name}</span>
                <ChevronRight className="size-3.5" aria-hidden="true" />
                <span>Playing as {props.campaign.protagonist_snapshot.name}</span>
              </div>
            </div>
            <Link to="/campaigns/new" className="pressable inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm text-foreground no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface">
              <BookOpen className="size-4" aria-hidden="true" />New campaign
            </Link>
          </header>

          {props.messagesError && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm" role="alert">
              <p className="flex-1 text-muted">{props.messagesError}</p>
              <button type="button" className="pressable min-h-9 rounded-lg border border-border px-3 text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void props.onRefreshMessages(props.sessionId); }}>Retry transcript load</button>
            </div>
          )}
          {props.messagesLoading && props.messages === undefined ? (
            <p className="flex-1 px-4 py-8 text-sm text-muted" role="status">Loading transcript…</p>
          ) : (
            <MessageScroller
              key={props.sessionId}
              className="flex-1"
              followOutput={following}
              followThreshold={56}
              onFollowChange={setFollowing}
              contentClassName="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6"
              label="Session transcript"
            >
              {messages.length === 0 ? (
                <div className="my-12 grid justify-items-center gap-3 rounded-xl border border-dashed border-border px-5 py-10 text-center">
                  <Sparkles className="size-6 text-accent" aria-hidden="true" />
                  <h2 className="text-lg font-semibold">{isActiveSession ? "Your session is ready" : "No transcript for this session"}</h2>
                  <p className="max-w-md text-sm text-muted">{isActiveSession ? "The narrator will open the first scene using the context you chose." : "This session is read-only and will not open or accept new actions."}</p>
                  {showEmptyOpening && <button type="button" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" onClick={() => props.onRetryOpening(props.sessionId, selectedModel || undefined)}>{live?.error ? "Retry opening" : "Begin opening"}</button>}
                </div>
              ) : messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  liveText={message.id === live?.pendingMessageId && message.status === "pending" && live.text ? live.text : undefined}
                  streaming={message.id === live?.pendingMessageId && live.phase === "streaming"}
                />
              ))}
              {unmatchedLive && live && (
                <article className="rounded-xl border border-dashed border-border bg-surface p-4">
                  <p className="mbs-0 mbe-2 text-sm font-semibold">Narrator <span className="text-xs font-normal text-muted">Draft · {live.phase === "stopping" ? "Stopping" : live.phase === "error" ? "Failed" : "Generating"}</span></p>
                  {live.text ? <Markdown content={live.text} streaming={live.phase === "streaming"} /> : live.phase === "streaming" ? <PendingDots /> : null}
                </article>
              )}
            </MessageScroller>
          )}

          {live?.error && (
            <div className="mx-auto flex w-full max-w-3xl items-start gap-2 px-4 pbe-2 text-sm" role="alert">
              <p className="flex-1 text-muted">
                {live.error}
                {live.code === "no_provider" && <> — <Link className="font-medium text-accent underline underline-offset-2" to="/settings/providers">Set up Z.AI in Settings</Link>.</>}
              </p>
              <button type="button" className="pressable inline-flex size-8 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={props.onDismissGeneration} aria-label="Dismiss notice"><X className="size-4" aria-hidden="true" /></button>
            </div>
          )}

          {canRetryOpening && !props.messagesLoading && (
            <div className="mx-auto w-full max-w-3xl px-4 pbe-2">
              <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => props.onRetryOpening(props.sessionId, selectedModel || undefined)} disabled={busy}>Retry opening</button>
            </div>
          )}

          {otherGeneration && (
            <p className="mx-auto w-full max-w-3xl px-4 pbe-2 text-sm text-muted" role="status">
              Another session is generating. <Link className="font-medium text-accent underline underline-offset-2" to={`/sessions/${encodeURIComponent(otherGeneration.sessionId)}`}>Open that session</Link>, or stop its generation here.
            </p>
          )}

          {otherGenerationError?.error && (
            <p className="mx-auto w-full max-w-3xl px-4 pbe-2 text-sm text-muted" role="alert">
              Generation in another session failed: {otherGenerationError.error}{" "}
              <Link className="font-medium text-accent underline underline-offset-2" to={`/sessions/${encodeURIComponent(otherGenerationError.sessionId)}`}>View that session</Link>.
            </p>
          )}

          {isActiveSession ? (
            <Composer
              value={props.draft}
              onValueChange={(value) => props.onDraftChange(props.sessionId, value)}
              onSubmit={handleSend}
              selectedModel={selectedModel}
              onModelChange={(model) => props.onModelChange(props.sessionId, model)}
              defaultModel={provider?.model ?? null}
              models={provider?.models ?? []}
              modelCatalogState={modelCatalogState}
              placeholder={`What does ${props.campaign.protagonist_snapshot.name} do or say?`}
              inputLabel={`What does ${props.campaign.protagonist_snapshot.name} do or say?`}
              sendLabel="Send action"
              busy={busy || !hasCompletedNarration}
              showStop={hasPending || Boolean(otherGeneration)}
              onStop={() => { void props.onStop(otherGeneration?.sessionId ?? props.sessionId); }}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-bs border-border px-4 py-3 text-sm" role="note">
              <p className="flex-1 text-muted">Read-only transcript. Only the active session can accept actions.</p>
              {props.session.id !== props.campaign.active_session_id && (
                <Link to={`/sessions/${encodeURIComponent(props.campaign.active_session_id)}`} className="font-medium text-accent underline underline-offset-2">Open active session</Link>
              )}
            </div>
          )}

          <Sheet open={detailsOpen} onOpenChange={setDetailsOpen} title="Campaign details" closeLabel="Close campaign details" className="drawer fixed inset-bs-0 inset-be-0 end-0 start-auto z-40 w-[min(100vw,28rem)] border-s border-e-0 border-border bg-surface">
            <CampaignDetailsSheet
              key={props.campaign.id}
              campaign={props.campaign}
              session={props.session}
              active={isActiveSession}
              canEndSession={isActiveSession && !busy}
              onSyncSession={props.onSyncSession}
            />
          </Sheet>
        </>
      )}
    </div>
  );
}
