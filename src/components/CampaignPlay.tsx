import { useEffect, useState, useSyncExternalStore } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Ellipsis, PanelRightOpen, RefreshCw, Sparkles, X } from "lucide-react";
import type { Campaign, Session } from "../../shared/domain";
import { fetchProvider, type ProviderConfig } from "../lib/provider";
import type { TranscriptMessage } from "../lib/storyApi";
import type { Generation } from "../lib/useChatGeneration";
import { Markdown } from "./Markdown";
import { AppHeader } from "./AppHeader";
import { Composer } from "./Composer";
import { MessageScroller } from "./MessageScroller";
import { Sheet } from "./Sheet";
import { CampaignPanel } from "./CampaignPanel";
import { isActiveCampaignSession } from "../lib/campaignLifecycle";
import "./message-menu.css";

const DOCKED_QUERY = "(min-width: 80rem)";
const PANEL_COLLAPSED_KEY = "storyfold-campaign-panel-collapsed";

function subscribeDocked(onChange: () => void) {
  const query = window.matchMedia(DOCKED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function PendingDots() {
  return (
    <p className="flex items-center gap-1 py-1" role="status" aria-label="Narration is in progress">
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="size-1.5 motion-safe:animate-pulse rounded-full bg-muted" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </p>
  );
}

const messageControlClasses =
  "pressable inline-flex size-7 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

const REVEAL_CLASSES =
  "opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100";

function MessageRow(props: {
  message: TranscriptMessage;
  liveText?: string;
  streaming?: boolean;
  trailing: boolean;
  lastUser: boolean;
  actionsAllowed: boolean;
  deleteCount: number;
  onRegenerate: () => void;
  onSelectVariant: (messageId: string) => void;
  onEditMessage: (messageId: string, content: string, andRegenerate: boolean) => Promise<void>;
  onDeleteMessage: (messageId: string, scope?: "variant" | "after") => Promise<void>;
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
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<"message" | "after" | null>(null);

  const variantIds = message.variant_ids ?? [];
  const variantIndex = message.variant_index ?? 0;
  const trailingNarration = props.trailing && message.role === "assistant";
  const showSwipes = trailingNarration && variantIds.length > 1;
  const canAct = props.actionsAllowed;
  const canEdit = canAct && message.status === "complete";
  const canDeleteSwipe = canAct && trailingNarration && !isDraft && variantIds.length > 1;
  const canRegenerate = canAct && trailingNarration && !isDraft;
  const canRetry = canAct && trailingNarration && (message.status === "failed" || message.status === "interrupted");
  // Controls stay visible while something on the row needs attention (pending draft, editor, confirmation).
  const reveal = canAct && !editing && !confirmDelete ? ` ${REVEAL_CLASSES}` : "";

  const startEdit = () => {
    setEditValue(message.content);
    setEditing(true);
  };
  const saveEdit = (andRegenerate: boolean) => {
    props.onEditMessage(message.id, editValue, andRegenerate).then(
      () => setEditing(false),
      () => {}, // the editor stays open; the parent surfaces the error banner
    );
  };
  const runDelete = (scope?: "variant" | "after") => {
    props.onDeleteMessage(message.id, scope).then(
      () => setConfirmDelete(null),
      () => {},
    );
  };

  const editForm = (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        saveEdit(false);
      }}
    >
      <textarea
        className="min-h-24 w-full rounded-lg border border-border bg-background p-3 text-[15px] leading-6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        value={editValue}
        onChange={(event) => setEditValue(event.target.value)}
        rows={Math.min(10, Math.max(3, editValue.split("\n").length))}
        autoFocus
        aria-label="Edit message"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="pressable min-h-9 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
          disabled={!editValue.trim()}
        >
          Save
        </button>
        {props.lastUser && (
          <button
            type="button"
            className="pressable min-h-9 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised disabled:pointer-events-none disabled:opacity-50"
            disabled={!editValue.trim()}
            onClick={() => saveEdit(true)}
          >
            Save &amp; regenerate
          </button>
        )}
        <button
          type="button"
          className="pressable min-h-9 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );

  const deleteConfirm = confirmDelete && (
    <div
      className="mbs-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3"
      role="group"
      aria-label={confirmDelete === "after" ? "Confirm deleting this message and everything after" : "Confirm deleting this message"}
    >
      <span className="text-sm text-muted">
        {confirmDelete === "after"
          ? `Delete this message and everything after it? This removes ${props.deleteCount} messages; notes and relationships are unchanged.`
          : "Delete this message? Notes and relationships are unchanged."}
      </span>
      <button
        type="button"
        className="pressable min-h-9 rounded-lg border border-border px-3 text-sm text-muted"
        onClick={() => runDelete(confirmDelete === "after" ? "after" : undefined)}
      >
        Delete
      </button>
      <button
        type="button"
        className="pressable min-h-9 rounded-lg border border-border px-3 text-sm"
        onClick={() => setConfirmDelete(null)}
      >
        Cancel
      </button>
    </div>
  );

  const menu = canAct && (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={messageControlClasses} aria-label="Message actions">
          <Ellipsis className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={12} className="message-menu-content">
          {canEdit && (
            <DropdownMenu.Item className="message-menu-item" onSelect={startEdit}>Edit</DropdownMenu.Item>
          )}
          {canDeleteSwipe && (
            <DropdownMenu.Item className="message-menu-item" onSelect={() => runDelete("variant")}>
              Delete swipe
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="message-menu-item">Delete</DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="message-menu-content" collisionPadding={12}>
                <DropdownMenu.Item className="message-menu-item" onSelect={() => setConfirmDelete("message")}>
                  This message
                </DropdownMenu.Item>
                <DropdownMenu.Item className="message-menu-item" onSelect={() => setConfirmDelete("after")}>
                  This and everything after
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  if (message.role === "user") {
    return (
      <article className="group flex flex-col items-end gap-1">
        <div className="flex max-w-full items-start justify-end gap-1">
          {menu && <span className={reveal}>{menu}</span>}
          <div className="max-w-[90%] rounded-2xl rounded-ee-md bg-accent-soft px-4 py-3 text-foreground">
            <p className="mbs-0 mbe-2 text-xs font-medium text-muted">{message.speaker_name}</p>
            {editing ? editForm : <p className="whitespace-pre-wrap text-[15px] leading-6">{message.content}</p>}
          </div>
        </div>
        {props.trailing && canAct && (
          <button
            type="button"
            className={`pressable inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground${reveal}`}
            onClick={props.onRegenerate}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Regenerate
          </button>
        )}
        {deleteConfirm}
      </article>
    );
  }

  return (
    <article className={`group rounded-xl ${isDraft ? "border border-dashed border-border bg-surface p-4" : ""}`}>
      <div className="mbs-0 mbe-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4 text-accent" aria-hidden="true" />
        <span>{message.speaker_name}</span>
        {isDraft && <span className="text-xs font-normal text-muted">{status}</span>}
        <div className={`ms-auto flex items-center gap-1${reveal}`}>
          {menu}
        </div>
      </div>
      {editing ? editForm : (
        content
          ? <Markdown content={content} streaming={props.streaming} />
          : message.status === "pending" ? <PendingDots /> : null
      )}
      {(showSwipes || canRegenerate || canRetry) && (
        <div className="mbs-2 flex flex-wrap items-center gap-2">
          {showSwipes && (
            <div className="flex items-center gap-0.5 text-xs font-normal text-muted" role="group" aria-label="Alternate replies">
              <button
                type="button"
                className={messageControlClasses}
                disabled={!canAct || variantIndex <= 0}
                onClick={() => props.onSelectVariant(variantIds[variantIndex - 1])}
                aria-label="Previous reply"
              >
                <ChevronLeft className="size-3.5" aria-hidden="true" />
              </button>
              <span>{variantIndex + 1}/{variantIds.length}</span>
              <button
                type="button"
                className={messageControlClasses}
                disabled={!canAct}
                onClick={() => variantIndex < variantIds.length - 1
                  ? props.onSelectVariant(variantIds[variantIndex + 1])
                  : props.onRegenerate()}
                aria-label={variantIndex < variantIds.length - 1 ? "Next reply" : "Regenerate reply"}
              >
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
          {canRegenerate && (
            <button
              type="button"
              className={messageControlClasses}
              onClick={props.onRegenerate}
              aria-label="Regenerate reply"
              title="Regenerate"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              className="pressable inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
              onClick={props.onRegenerate}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      )}
      {deleteConfirm}
    </article>
  );
}


export function CampaignPlay(props: {
  sessionId: string;
  campaign: Campaign | null;
  session: Session | null;
  sessionLoading: boolean;
  sessionError: string;
  messages: TranscriptMessage[] | undefined;
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
  onRegenerate: (sessionId: string, model?: string) => boolean;
  onSelectVariant: (sessionId: string, messageId: string) => Promise<void>;
  onEditMessage: (sessionId: string, messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (sessionId: string, messageId: string, scope?: "variant" | "after") => Promise<void>;
  onStop: (sessionId: string) => void | Promise<void>;
  onRefreshMessages: (sessionId: string) => void | Promise<void>;
  onRetrySession: (sessionId: string) => void | Promise<void>;
  onDismissGeneration: () => void;
  onSyncSession: (sessionId: string) => Promise<void>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const docked = useSyncExternalStore(subscribeDocked, () => window.matchMedia(DOCKED_QUERY).matches);
  const [panelCollapsed, setPanelCollapsed] = useState(() => localStorage.getItem(PANEL_COLLAPSED_KEY) === "1");
  const [following, setFollowing] = useState(true);
  const [actionError, setActionError] = useState("");
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
  const transcriptReady = props.messages !== undefined && !props.messagesLoading && !props.messagesError;
  const busy = !transcriptReady || hasPending || live?.phase === "streaming" || live?.phase === "stopping" || Boolean(otherGeneration) || modelCatalogState === "loading";
  const hasCompletedNarration = messages.some((message) => message.role === "assistant" && message.status === "complete");
  const actionsAllowed = isActiveSession && !busy;
  const lastUserMessageId = messages.filter((message) => message.role === "user").at(-1)?.id;
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
    setActionError("");
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
  const regenerateModel = selectedModel || undefined;
  const surfaceActionError = (error: unknown) => {
    setActionError(error instanceof Error && error.message.trim() ? error.message : "That action failed. Try again.");
  };
  const handleRegenerate = () => {
    setActionError("");
    setFollowing(true);
    props.onRegenerate(props.sessionId, regenerateModel);
  };
  const handleSelectVariant = (messageId: string) => {
    setActionError("");
    props.onSelectVariant(props.sessionId, messageId).catch(surfaceActionError);
  };
  const handleEditMessage = (messageId: string, content: string, andRegenerate: boolean) => {
    setActionError("");
    const saved = props.onEditMessage(props.sessionId, messageId, content);
    saved.catch(surfaceActionError);
    if (!andRegenerate) return saved;
    return saved.then(() => { props.onRegenerate(props.sessionId, regenerateModel); });
  };
  const handleDeleteMessage = (messageId: string, scope?: "variant" | "after") => {
    setActionError("");
    const removed = props.onDeleteMessage(props.sessionId, messageId, scope);
    removed.catch(surfaceActionError);
    return removed;
  };
  const unmatchedLive = live?.pendingMessageId
    ? !messages.some((message) => message.id === live.pendingMessageId)
    : false;

  useEffect(() => {
    localStorage.setItem(PANEL_COLLAPSED_KEY, panelCollapsed ? "1" : "0");
  }, [panelCollapsed]);

  useEffect(() => {
    if (docked) setDetailsOpen(false);
  }, [docked]);

  const panelProps = props.campaign && props.session ? {
    campaign: props.campaign,
    session: props.session,
    active: isActiveSession,
    canEndSession: isActiveSession && !busy,
    onSyncSession: props.onSyncSession,
  } : null;

  return (
    <div className="flex min-inline-0 flex-1">
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader
        title={props.campaign?.name ?? "Campaign"}
        subtitle={props.session ? `${props.session.title}${isActiveSession ? "" : " · Read-only"}` : undefined}
        onOpenSidebar={props.onOpenSidebar}
        actions={panelProps && !docked && <button type="button" className="pressable inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground" onClick={() => setDetailsOpen(true)}><PanelRightOpen className="size-4" aria-hidden="true" />Campaign</button>}
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
              ) : messages.map((message, index) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  liveText={message.id === live?.pendingMessageId && message.status === "pending" && live.text ? live.text : undefined}
                  streaming={message.id === live?.pendingMessageId && live.phase === "streaming"}
                  trailing={index === messages.length - 1}
                  lastUser={message.id === lastUserMessageId}
                  actionsAllowed={actionsAllowed}
                  deleteCount={messages.length - index}
                  onRegenerate={handleRegenerate}
                  onSelectVariant={handleSelectVariant}
                  onEditMessage={handleEditMessage}
                  onDeleteMessage={handleDeleteMessage}
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

          {actionError && (
            <div className="mx-auto flex w-full max-w-3xl items-start gap-2 px-4 pbe-2 text-sm" role="alert">
              <p className="flex-1 text-muted">{actionError}</p>
              <button type="button" className="pressable inline-flex size-8 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => setActionError("")} aria-label="Dismiss notice"><X className="size-4" aria-hidden="true" /></button>
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
        </>
      )}
    </div>
      {panelProps && (docked ? (
        <aside
          aria-label="Campaign panel"
          className={`sidebar-shell flex-none overflow-clip border-s border-border bg-surface ${panelCollapsed ? "w-14" : "w-[24rem]"}`}
        >
          <div className={`h-full ${panelCollapsed ? "" : "w-[calc(24rem_-_1px)]"}`}>
            <CampaignPanel key={panelProps.campaign.id} {...panelProps} collapsed={panelCollapsed} onCollapsedChange={setPanelCollapsed} />
          </div>
        </aside>
      ) : (
        <Sheet open={detailsOpen} onOpenChange={setDetailsOpen} title="Campaign panel" closeLabel="Close campaign panel" className="drawer fixed inset-bs-0 inset-be-0 end-0 start-auto z-40 w-[min(100%,26rem)] border-s border-e-0 border-border bg-surface">
          <CampaignPanel key={panelProps.campaign.id} {...panelProps} />
        </Sheet>
      ))}
    </div>
  );
}
