import { useEffect, useState } from "react";
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
import { worldEntryGroups } from "../lib/worldEntryGroups";

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

function CampaignCharacterSnapshot(props: { character: CharacterSnapshot; role: string }) {
  return (
    <section className="mbs-5 grid gap-2 border-bs border-border pbs-4">
      <p className="text-xs font-medium text-muted">{props.role}</p>
      <h3 className="font-semibold">{props.character.name}</h3>
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
    </section>
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
  const hasPending = messages.some((message) => message.role === "assistant" && message.status === "pending")
    || Boolean(live?.pendingMessageId && live.phase !== "error");
  const hasCompletedNarration = messages.some((message) => message.role === "assistant" && message.status === "complete");
  const canRetryOpening = !hasCompletedNarration
    && messages.some((message) => message.role === "assistant" && (message.status === "failed" || message.status === "interrupted"));
  const transcriptReady = props.messages !== undefined && !props.messagesLoading && !props.messagesError;
  const busy = !transcriptReady || hasPending || live?.phase === "streaming" || live?.phase === "stopping" || Boolean(otherGeneration) || modelCatalogState === "loading";
  const showEmptyOpening = messages.length === 0 && !busy && (!live || live.phase === "error");

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
    if (props.sessionLoading || props.sessionError || !props.session || !transcriptReady || modelCatalogState === "loading") return;
    if (messages.length !== 0) return;
    props.onOpen(props.sessionId, selectedModel || undefined);
  }, [messages.length, modelCatalogState, props.generation?.phase, props.generation?.sessionId, props.onOpen, props.session, props.sessionError, props.sessionId, props.sessionLoading, selectedModel, transcriptReady]);

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
              <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Current session</p>
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
                  <h2 className="text-lg font-semibold">Your session is ready</h2>
                  <p className="max-w-md text-sm text-muted">The narrator will open the first scene using the context you chose.</p>
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

          <Sheet open={detailsOpen} onOpenChange={setDetailsOpen} title="Campaign details" closeLabel="Close campaign details" className="drawer fixed inset-bs-0 inset-be-0 end-0 start-auto z-40 w-[min(100vw,28rem)] border-s border-e-0 border-border bg-surface">
            <div className="flex h-full min-block-size-0 flex-col">
              <div className="flex-none border-bs border-border p-5 pe-14">
                <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Your context</p>
                <h2 className="mbs-1 text-xl font-semibold">{props.campaign.name}</h2>
              </div>
              <div className="chat-scroll flex-1 p-5">
                <section className="grid gap-2 border-bs border-border pbs-4">
                  <p className="text-xs font-medium text-muted">Current session</p>
                  <h3 className="font-semibold">{props.session.title}</h3>
                </section>
                <section className="mbs-5 grid gap-2 border-bs border-border pbs-4">
                  <p className="text-xs font-medium text-muted">World</p>
                  <h3 className="font-semibold">{props.campaign.world_snapshot.name}</h3>
                  <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{props.campaign.world_snapshot.setting_brief}</p>
                </section>
                <CampaignCharacterSnapshot character={props.campaign.protagonist_snapshot} role="Playing as" />
                {props.campaign.cast.map((character) => (
                  <CampaignCharacterSnapshot key={character.id} character={character} role="Narrator-controlled cast" />
                ))}
                <section className="mbs-5 grid gap-2 border-bs border-border pbs-4">
                  <p className="text-xs font-medium text-muted">Campaign starting situation</p>
                  <p className="whitespace-pre-wrap text-sm leading-6">{props.campaign.starting_situation || "No starting situation specified."}</p>
                </section>
                <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-labelledby="campaign-captured-entries-title">
                  <div>
                    <p className="text-xs font-medium text-muted">Campaign grounding</p>
                    <h3 id="campaign-captured-entries-title" className="mbs-1 font-semibold">Captured compendium</h3>
                  </div>
                  {props.campaign.world_snapshot.entries.length === 0 ? (
                    <p className="text-sm text-muted">No compendium entries were included in this campaign.</p>
                  ) : (
                    worldEntryGroups
                      .map((group) => ({
                        ...group,
                        entries: props.campaign!.world_snapshot.entries.filter((entry) => entry.kind === group.kind),
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
                </section>
              </div>
            </div>
          </Sheet>
        </>
      )}
    </div>
  );
}
