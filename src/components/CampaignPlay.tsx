import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Clapperboard, Ellipsis, Maximize2, Minimize2, PanelRightOpen, RefreshCw, Sparkles, X } from "lucide-react";
import { protagonistOf, type Campaign, type CampaignCharacter, type Session } from "../../shared/domain";
import { fetchProvider, type ProviderConfig } from "../lib/provider";
import {
  createCampaignCharacter,
  deleteCampaignCharacterAvatar,
  forkFromMessage,
  updateCampaignCharacter,
  uploadCampaignCharacterAvatar,
  type TranscriptMessage,
} from "../lib/storyApi";
import type { Generation } from "../lib/useChatGeneration";
import { CharacterProfileDialog } from "./CharacterProfileDialog";
import { Narration } from "./Narration";
import { AppHeader } from "./AppHeader";
import { Composer } from "./Composer";
import { MessageScroller } from "./MessageScroller";
import { Sheet } from "./Sheet";
import { CampaignPanel } from "./CampaignPanel";
import { isActiveCampaignSession } from "../lib/campaignLifecycle";
import { keepEscapeInFindPanel, TextEditor } from "./TextEditor";
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

function ThinkingDisclosure(props: { reasoning: string; answering: boolean }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [props.reasoning]);
  return (
    <details
      className="mbe-2 text-sm text-muted"
      onToggle={() => {
        const element = textRef.current;
        if (element && pinned.current) element.scrollTop = element.scrollHeight;
      }}
    >
      <summary className="cursor-pointer select-none">{props.answering ? "Thought process" : "Thinking…"}</summary>
      <p
        ref={textRef}
        className="mbs-2 max-h-48 overflow-y-auto whitespace-pre-wrap border-s-2 border-border ps-3 text-xs leading-5"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
        }}
      >
        {props.reasoning}
      </p>
    </details>
  );
}

const messageControlClasses =
  "pressable inline-flex size-7 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

const REVEAL_CLASSES =
  "opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100";

function MessageRow(props: {
  message: TranscriptMessage;
  liveText?: string;
  reasoning?: string;
  characters: CampaignCharacter[];
  /** Offered on walk-on speakers; absent where the cast cannot change from here. */
  onAddToCast?: (name: string) => void;
  onShowCharacter: (characterId: string) => void;
  streaming?: boolean;
  trailing: boolean;
  lastUser: boolean;
  actionsAllowed: boolean;
  /** Generation-starting controls need the app-wide exclusivity, not just session-level actions. */
  canGenerate: boolean;
  /** Forking works in the active session and in closed (read-only) sessions. */
  canFork: boolean;
  /** A closed session forks from its checkpoint, not the current state. */
  activeSession: boolean;
  campaignName: string;
  deleteCount: number;
  onRegenerate: (direction?: string) => void;
  onSelectVariant: (messageId: string) => void;
  onEditMessage: (messageId: string, content: string, andRegenerate: boolean) => Promise<void>;
  onDeleteMessage: (messageId: string, scope?: "variant" | "after") => Promise<void>;
  onForkMessage: (messageId: string, name: string) => Promise<void>;
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
  const [editExpanded, setEditExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<"message" | "after" | null>(null);
  const [confirmFork, setConfirmFork] = useState(false);
  const [forkName, setForkName] = useState("");
  const [forking, setForking] = useState(false);
  const [directing, setDirecting] = useState(false);
  const [directionValue, setDirectionValue] = useState("");

  const variantIds = message.variant_ids ?? [];
  const variantIndex = message.variant_index ?? 0;
  const trailingNarration = props.trailing && message.role === "assistant";
  const showSwipes = trailingNarration && variantIds.length > 1;
  const canAct = props.actionsAllowed;
  const canEdit = canAct && message.status === "complete";
  const canFork = props.canFork && !isDraft;
  const canDeleteSwipe = canAct && trailingNarration && !isDraft && variantIds.length > 1;
  const canRegenerate = props.canGenerate && trailingNarration && !isDraft;
  const canRetry = props.canGenerate && trailingNarration && (message.status === "failed" || message.status === "interrupted");
  const canDirect = props.canGenerate && props.trailing;
  // Controls stay visible while something on the row needs attention (pending draft, editor, confirmation).
  const reveal = canAct && !editing && !confirmDelete && !confirmFork && !directing ? ` ${REVEAL_CLASSES}` : "";

  // Radix returns focus to the ⋯ trigger on close; skip that when an item opens
  // an inline form, so it keeps focus and scrolls into view.
  const keepMenuFocus = useRef(false);
  const deleteConfirmRef = useRef<HTMLDivElement>(null);
  const forkConfirmRef = useRef<HTMLFormElement>(null);
  const directFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (confirmDelete) deleteConfirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [confirmDelete]);
  useEffect(() => {
    if (!confirmFork) return;
    forkConfirmRef.current?.scrollIntoView({ block: "nearest" });
    const frame = requestAnimationFrame(() => forkConfirmRef.current?.querySelector("input")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [confirmFork]);
  useEffect(() => {
    if (directing) directFormRef.current?.scrollIntoView({ block: "nearest" });
  }, [directing]);
  const startEdit = () => {
    keepMenuFocus.current = true;
    setEditValue(message.content);
    setEditExpanded(false);
    setEditing(true);
  };
  const startDelete = (scope: "message" | "after") => {
    keepMenuFocus.current = true;
    setConfirmDelete(scope);
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
  const startFork = () => {
    keepMenuFocus.current = true;
    setForkName(`${props.campaignName} fork`);
    setConfirmFork(true);
  };
  const runFork = () => {
    if (forking) return;
    setForking(true);
    props.onForkMessage(message.id, forkName).then(
      () => setConfirmFork(false),
      () => setForking(false), // the parent surfaces the error banner
    );
  };
  const startDirect = () => {
    keepMenuFocus.current = true;
    setDirectionValue(message.role === "assistant" ? message.direction ?? "" : "");
    setDirecting(true);
  };

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    saveEdit(false);
  };
  const editField = (expanded: boolean) => (
    <TextEditor
      value={editValue}
      onChange={setEditValue}
      label="Edit message"
      markdown
      autoFocus
      className={`rounded-lg border border-border bg-background ${expanded ? "[min-block-size:0] flex-1" : "min-h-24"}`}
    />
  );
  const editButtons = (expanded: boolean) => (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="submit"
        className="pressable min-h-9 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
        disabled={!editValue.trim()}
      >
        Save
      </button>
      {props.lastUser && props.canGenerate && (
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
      <button
        type="button"
        className="pressable ms-auto inline-flex size-9 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
        aria-label={expanded ? "Collapse editor" : "Expand editor"}
        onClick={() => setEditExpanded(!expanded)}
      >
        {expanded ? <Minimize2 className="size-4" aria-hidden="true" /> : <Maximize2 className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
  const editForm = (
    <form className="grid gap-2" onSubmit={submitEdit}>
      {editField(false)}
      {editButtons(false)}
    </form>
  );
  const editDialog = editing && editExpanded && (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) setEditExpanded(false); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="backdrop fixed inset-0 z-30 bg-black/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // The collapsed editor takes focus itself when it remounts.
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={keepEscapeInFindPanel}
          className="fixed inset-0 z-40 flex flex-col bg-surface md:inset-bs-1/2 md:inset-be-auto md:start-1/2 md:h-[min(90dvh,52rem)] md:w-[min(calc(100vw-2rem),52rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-xl"
        >
          <form className="flex [min-block-size:0] flex-1 flex-col gap-3 p-4 [padding-block-end:calc(1rem+env(safe-area-inset-bottom,0px))] md:p-5" onSubmit={submitEdit}>
            <DialogPrimitive.Title className="text-base font-semibold">Edit message</DialogPrimitive.Title>
            {editField(true)}
            {editButtons(true)}
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );

  const deleteConfirm = confirmDelete && (
    <div
      ref={deleteConfirmRef}
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

  const forkConfirm = confirmFork && (
    <form
      ref={forkConfirmRef}
      className="mbs-2 grid gap-2 rounded-lg border border-border bg-surface p-3"
      role="group"
      aria-label="Confirm forking the campaign from this message"
      onSubmit={(event) => {
        event.preventDefault();
        runFork();
      }}
    >
      <label className="grid gap-1 text-sm">
        New campaign name
        <input
          className="min-h-11 rounded-lg border border-border bg-background px-3"
          value={forkName}
          onChange={(event) => setForkName(event.target.value)}
          required
          autoFocus
        />
      </label>
      <p className="text-sm text-muted">
        Copies the story up to this message into a new campaign.{" "}
        {props.activeSession
          ? "Characters, stats, notes, and relationships are copied as they are now."
          : "Characters, stats, notes, and relationships are restored as they were when this session closed."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="pressable min-h-9 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
          disabled={forking}
        >
          {forking ? "Forking…" : "Fork"}
        </button>
        <button
          type="button"
          className="pressable min-h-9 rounded-lg border border-border px-3 text-sm"
          onClick={() => setConfirmFork(false)}
          disabled={forking}
        >
          Cancel
        </button>
      </div>
    </form>
  );

  const directForm = directing && (
    <form
      ref={directFormRef}
      className="mbs-2 grid w-full gap-2 rounded-lg border border-border bg-surface p-3"
      aria-label="Regenerate with an out-of-character direction"
      onSubmit={(event) => {
        event.preventDefault();
        setDirecting(false);
        props.onRegenerate(directionValue);
      }}
    >
      <label className="grid gap-1 text-sm">
        Direction for the narrator
        <textarea
          className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-[15px] leading-6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          value={directionValue}
          onChange={(event) => setDirectionValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          rows={2}
          placeholder="Make Vex angrier; don't resolve the fight yet"
          required
          autoFocus
        />
      </label>
      <p className="text-sm text-muted">Sent as an OOC note for this reply only.</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="pressable min-h-9 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
          disabled={!directionValue.trim() || !props.canGenerate}
        >
          Regenerate
        </button>
        <button
          type="button"
          className="pressable min-h-9 rounded-lg border border-border px-3 text-sm"
          onClick={() => setDirecting(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );

  const menu = (canAct || canFork) && (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={messageControlClasses} aria-label="Message actions">
          <Ellipsis className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={12}
          className="message-menu-content"
          onCloseAutoFocus={(event) => {
            if (!keepMenuFocus.current) return;
            keepMenuFocus.current = false;
            event.preventDefault();
          }}
        >
          {canDirect && (
            <DropdownMenu.Item className="message-menu-item" onSelect={startDirect}>
              Regenerate with direction…
            </DropdownMenu.Item>
          )}
          {canEdit && (
            <DropdownMenu.Item className="message-menu-item" onSelect={startEdit}>Edit</DropdownMenu.Item>
          )}
          {canDeleteSwipe && (
            <DropdownMenu.Item className="message-menu-item" onSelect={() => runDelete("variant")}>
              Delete swipe
            </DropdownMenu.Item>
          )}
          {canAct && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="message-menu-item">Delete</DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="message-menu-content" collisionPadding={12}>
                  <DropdownMenu.Item className="message-menu-item" onSelect={() => startDelete("message")}>
                    This message
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="message-menu-item" onSelect={() => startDelete("after")}>
                    This and everything after
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}
          {canFork && (
            <DropdownMenu.Item className="message-menu-item" onSelect={startFork}>
              Fork from here
            </DropdownMenu.Item>
          )}
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
            {editing && !editExpanded ? editForm : <p className="whitespace-pre-wrap text-[15px] leading-6">{message.content}</p>}
          </div>
        </div>
        {props.trailing && props.canGenerate && (
          <button
            type="button"
            className={`pressable inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground${reveal}`}
            onClick={() => props.onRegenerate()}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Regenerate
          </button>
        )}
        {editDialog}
        {deleteConfirm}
        {forkConfirm}
        {directForm}
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
      {props.reasoning && <ThinkingDisclosure reasoning={props.reasoning} answering={Boolean(content)} />}
      {message.direction && <DirectionNote direction={message.direction} />}
      {editing && !editExpanded ? editForm : (
        content
          ? <Narration content={content} streaming={props.streaming} characters={props.characters} onAddToCast={props.onAddToCast} onShowCharacter={props.onShowCharacter} />
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
                disabled={!canAct || (variantIndex >= variantIds.length - 1 && !props.canGenerate)}
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
              onClick={() => props.onRegenerate()}
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
              onClick={() => props.onRegenerate()}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      )}
      {editDialog}
      {deleteConfirm}
      {forkConfirm}
      {directForm}
    </article>
  );
}

function DirectionNote(props: { direction: string }) {
  return (
    <p className="mbs-0 mbe-2 flex items-start gap-1.5 text-xs leading-5 text-muted">
      <Clapperboard className="mbs-0.5 size-3.5 flex-none" aria-hidden="true" />
      <span className="min-w-0 break-words">Directed: {props.direction}</span>
    </p>
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
  onSend: (sessionId: string, value: string, direction?: string, model?: string) => void;
  onOpen: (sessionId: string, direction?: string, model?: string) => boolean;
  onRegenerate: (sessionId: string, direction?: string, model?: string) => boolean;
  onSelectVariant: (sessionId: string, messageId: string) => Promise<void>;
  onEditMessage: (sessionId: string, messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (sessionId: string, messageId: string, scope?: "variant" | "after") => Promise<void>;
  onStop: (sessionId: string) => void | Promise<void>;
  onRefreshMessages: (sessionId: string) => void | Promise<void>;
  onRetrySession: (sessionId: string) => void | Promise<void>;
  onDismissGeneration: () => void;
  onSyncSession: (sessionId: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [walkOnName, setWalkOnName] = useState<string | null>(null);
  const [revealedCharacter, setRevealedCharacter] = useState<{ id: string; key: number } | null>(null);
  const docked = useSyncExternalStore(subscribeDocked, () => window.matchMedia(DOCKED_QUERY).matches);
  const [panelCollapsed, setPanelCollapsed] = useState(() => localStorage.getItem(PANEL_COLLAPSED_KEY) === "1");
  const [following, setFollowing] = useState(true);
  const [actionError, setActionError] = useState("");
  // null: the composer's direction field is closed.
  const [direction, setDirection] = useState<string | null>(null);
  const [openingDirection, setOpeningDirection] = useState("");
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [modelCatalogState, setModelCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const messages = props.messages ?? [];
  const characters = props.campaign?.characters ?? [];
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
  const transcriptReady = props.messages !== undefined && !props.messagesError;
  const busy = !transcriptReady || hasPending || live?.phase === "streaming" || live?.phase === "stopping" || Boolean(otherGeneration) || modelCatalogState === "loading";
  const hasCompletedNarration = messages.some((message) => message.role === "assistant" && message.status === "complete");
  // Row actions match what the server accepts for this session; only sends need
  // the app-wide exclusivity that `busy` tracks.
  const sessionBusy = hasPending || live?.phase === "streaming" || live?.phase === "stopping";
  const actionsAllowed = isActiveSession && transcriptReady && !sessionBusy;
  const canGenerate = actionsAllowed && !busy;
  // Forking is allowed in the active session and in closed (read-only) ones,
  // but the server refuses it while this campaign's active session generates.
  const campaignGenerating = otherGeneration?.sessionId === props.campaign?.active_session_id;
  const canFork = transcriptReady && !sessionBusy && !campaignGenerating;
  const lastUserMessageId = messages.filter((message) => message.role === "user").at(-1)?.id;
  const addToCast = isActiveSession && !sessionBusy ? setWalkOnName : undefined;
  const showCharacter = (id: string) => {
    setRevealedCharacter((current) => ({ id, key: (current?.key ?? 0) + 1 }));
    if (!docked) setDetailsOpen(true);
  };
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
    setDirection(null);
    setOpeningDirection("");
  }, [props.sessionId]);

  useEffect(() => {
    if (!hasPending) return;
    const refresh = () => { void props.onRefreshMessages(props.sessionId); };
    const interval = window.setInterval(refresh, 3000);
    return () => window.clearInterval(interval);
  }, [hasPending, props.onRefreshMessages, props.sessionId]);

  const handleSend = (value: string) => {
    setFollowing(true);
    props.onSend(props.sessionId, value, direction ?? undefined, selectedModel || undefined);
  };
  // The direction belongs to the accepted turn; a refused send keeps it for the retry.
  const acceptedTurnId = live?.kind === "message" ? live.pendingMessageId : undefined;
  useEffect(() => {
    if (acceptedTurnId) setDirection(null);
  }, [acceptedTurnId]);
  const regenerateModel = selectedModel || undefined;
  const surfaceActionError = (error: unknown) => {
    setActionError(error instanceof Error && error.message.trim() ? error.message : "That action failed. Try again.");
  };
  const handleRegenerate = (direction?: string) => {
    setActionError("");
    setFollowing(true);
    props.onRegenerate(props.sessionId, direction, regenerateModel);
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
    return saved.then(() => { props.onRegenerate(props.sessionId, undefined, regenerateModel); });
  };
  const handleDeleteMessage = (messageId: string, scope?: "variant" | "after") => {
    setActionError("");
    const removed = props.onDeleteMessage(props.sessionId, messageId, scope);
    removed.catch(surfaceActionError);
    return removed;
  };
  const handleForkFromMessage = (messageId: string, name: string) => {
    setActionError("");
    const forked = forkFromMessage(props.sessionId, messageId, name).then(async (result) => {
      // The fork exists now; a failed list refresh must not invite a duplicate retry.
      await props.onSyncSession(result.session.id).catch(() => {});
      navigate(`/sessions/${encodeURIComponent(result.session.id)}`);
    });
    forked.catch(surfaceActionError);
    return forked;
  };
  const trailingMessage = messages.at(-1);
  const liveUnlisted = live
    ? live.pendingMessageId
      ? !messages.some((message) => message.id === live.pendingMessageId)
      : live.phase !== "error" && (live.kind === "regenerate" || live.kind === "message")
    : false;
  const regenerateInPlace = liveUnlisted && live?.kind === "regenerate" && live.phase !== "error" && trailingMessage?.role === "assistant";
  // A send renders its player turn optimistically until the transcript lists
  // the accepted row; before acceptance the row cannot exist yet.
  const sending = live?.kind === "message" && live.phase !== "error" ? live : null;
  const sentListed = !sending || (sending.playerMessageId !== undefined
    && messages.some((message) => message.id === sending.playerMessageId));
  const unmatchedLive = liveUnlisted && !regenerateInPlace;
  const displayedMessages = regenerateInPlace && trailingMessage ? (() => {
    const kept = (trailingMessage.variant_ids ?? []).filter((id) => trailingMessage.status === "complete" || id !== trailingMessage.id);
    return [
      ...messages.slice(0, -1),
      { ...trailingMessage, status: "pending" as const, content: "", direction: live?.direction ?? null, variant_ids: [...kept, ""], variant_index: kept.length },
    ];
  })() : messages;

  useEffect(() => {
    const variantIds = trailingMessage?.role === "assistant" ? trailingMessage.variant_ids ?? [] : [];
    if (!actionsAllowed || variantIds.length < 2) return;
    const variantIndex = trailingMessage?.variant_index ?? 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role='menu'], [role='dialog']"))) return;
      if (event.key === "ArrowLeft") {
        if (variantIndex <= 0) return;
        handleSelectVariant(variantIds[variantIndex - 1]);
      } else if (variantIndex < variantIds.length - 1) {
        handleSelectVariant(variantIds[variantIndex + 1]);
      } else if (canGenerate) {
        handleRegenerate();
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    localStorage.setItem(PANEL_COLLAPSED_KEY, panelCollapsed ? "1" : "0");
  }, [panelCollapsed]);

  const stopTarget = otherGeneration?.sessionId ?? props.sessionId;
  // The run is reserved server-side before acceptance headers arrive, so Stop
  // works from the moment a local generation starts.
  const stopAvailable = hasPending || live?.phase === "streaming" || Boolean(otherGeneration);
  useEffect(() => {
    // Double-Esc mirrors the composer Stop control; an Esc that closed a menu
    // or dialog arrives default-prevented and does not count.
    if (!stopAvailable) return;
    let lastEscape: number | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const now = performance.now();
      if (lastEscape !== null && now - lastEscape <= 500) {
        lastEscape = null;
        event.preventDefault();
        void props.onStop(stopTarget);
      } else {
        lastEscape = now;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stopAvailable, stopTarget, props.onStop]);


  useEffect(() => {
    if (docked) setDetailsOpen(false);
  }, [docked]);

  const panelProps = props.campaign && props.session ? {
    campaign: props.campaign,
    session: props.session,
    active: isActiveSession,
    canEndSession: isActiveSession && !busy,
    onSyncSession: props.onSyncSession,
    revealCharacter: revealedCharacter,
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
                  <p className="max-w-md text-sm text-muted">{isActiveSession ? "Set up characters, notes, and relationships in the campaign panel, then begin the opening." : "This session is read-only and will not open or accept new actions."}</p>
                  {showEmptyOpening && (
                    <form
                      className="grid w-full max-w-md gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        props.onOpen(props.sessionId, openingDirection, selectedModel || undefined);
                      }}
                    >
                      <label className="grid gap-1 text-start text-sm">
                        <span>Direction for the opening <span className="text-muted">(optional)</span></span>
                        <input
                          className="min-h-11 rounded-lg border border-border bg-background px-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                          value={openingDirection}
                          onChange={(event) => setOpeningDirection(event.target.value)}
                          placeholder="Open mid-chase through the night market"
                        />
                      </label>
                      <button type="submit" className="pressable min-h-11 justify-self-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90">{live?.error ? "Retry opening" : "Begin opening"}</button>
                    </form>
                  )}
                </div>
              ) : displayedMessages.map((message, index) => {
                const isLive = regenerateInPlace ? index === displayedMessages.length - 1 : message.id === live?.pendingMessageId && message.status === "pending";
                return (
                <MessageRow
                  key={message.id}
                  message={message}
                  liveText={isLive && live?.text ? live.text : undefined}
                  reasoning={isLive ? live?.reasoning : undefined}
                  streaming={isLive && live?.phase === "streaming"}
                  characters={characters}
                  onAddToCast={addToCast}
                  onShowCharacter={showCharacter}
                  trailing={index === messages.length - 1}
                  lastUser={message.id === lastUserMessageId}
                  actionsAllowed={actionsAllowed}
                  canGenerate={canGenerate}
                  canFork={canFork}
                  activeSession={isActiveSession}
                  campaignName={props.campaign?.name ?? "Campaign"}
                  deleteCount={messages.length - index}
                  onRegenerate={handleRegenerate}
                  onSelectVariant={handleSelectVariant}
                  onEditMessage={handleEditMessage}
                  onDeleteMessage={handleDeleteMessage}
                  onForkMessage={(messageId, name) => handleForkFromMessage(messageId, name)}
                />
                );
              })}
              {sending && !sentListed && props.campaign && (
                <MessageRow
                  key="optimistic-player-turn"
                  message={{
                    id: "optimistic-player-turn",
                    session_id: props.sessionId,
                    position: messages.length + 1,
                    role: "user",
                    speaker_name: protagonistOf(props.campaign).name,
                    content: sending.playerText ?? "",
                    status: "complete",
                    direction: null,
                    created_at: "",
                    updated_at: "",
                  }}
                  trailing={false}
                  lastUser={false}
                  actionsAllowed={false}
                  canGenerate={false}
                  characters={characters}
                  canFork={false}
                  activeSession={isActiveSession}
                  campaignName={props.campaign?.name ?? "Campaign"}
                  deleteCount={0}
                  onRegenerate={handleRegenerate}
                  onSelectVariant={handleSelectVariant}
                  onEditMessage={handleEditMessage}
                  onDeleteMessage={handleDeleteMessage}
                  onForkMessage={(messageId, name) => handleForkFromMessage(messageId, name)}
                  onShowCharacter={showCharacter}
                />
              )}
              {unmatchedLive && live && (
                <article className="rounded-xl border border-dashed border-border bg-surface p-4">
                  <p className="mbs-0 mbe-2 text-sm font-semibold">Narrator <span className="text-xs font-normal text-muted">Draft · {live.phase === "stopping" ? "Stopping" : live.phase === "error" ? "Failed" : "Generating"}</span></p>
                  {live.reasoning && <ThinkingDisclosure reasoning={live.reasoning} answering={Boolean(live.text)} />}
                  {live.direction && <DirectionNote direction={live.direction} />}
                  {live.text ? <Narration content={live.text} streaming={live.phase === "streaming"} characters={characters} onShowCharacter={showCharacter} /> : live.phase === "streaming" ? <PendingDots /> : null}
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
              direction={direction}
              onDirectionChange={setDirection}
              selectedModel={selectedModel}
              onModelChange={(model) => props.onModelChange(props.sessionId, model)}
              defaultModel={provider?.model ?? null}
              models={provider?.models ?? []}
              modelCatalogState={modelCatalogState}
              placeholder={`What does ${protagonistOf(props.campaign).name} do or say?`}
              inputLabel={`What does ${protagonistOf(props.campaign).name} do or say?`}
              sendLabel="Send action"
              busy={busy || !hasCompletedNarration}
              showStop={stopAvailable}
              onStop={() => { void props.onStop(stopTarget); }}
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
      {walkOnName !== null && props.campaign && (
        <CharacterProfileDialog
          character={null}
          initialName={walkOnName}
          title={`Add ${walkOnName} to the cast`}
          description="Adds a narrator-controlled cast character to this campaign. Paragraphs tagged with this name use their profile."
          onCreate={(input) => createCampaignCharacter(props.campaign!.id, input)}
          onUpdate={(id, input) => updateCampaignCharacter(props.campaign!.id, id, input)}
          onAvatarUpload={(id, file) => uploadCampaignCharacterAvatar(props.campaign!.id, id, file)}
          onAvatarRemove={(id) => deleteCampaignCharacterAvatar(props.campaign!.id, id)}
          onSaved={() => { void props.onSyncSession(props.sessionId).catch(() => {}); }}
          onClose={() => setWalkOnName(null)}
        />
      )}
    </div>
  );
}
