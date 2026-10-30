import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Link, useNavigate } from "react-router-dom";
import { BookOpen, ChevronLeft, ChevronRight, Clapperboard, Ellipsis, GitBranch, Globe2, Maximize2, MessageSquareQuote, Minimize2, PanelRightOpen, Pencil, RefreshCw, Rewind, Sparkles, Trash2, X, type LucideIcon } from "lucide-react";
import { Avatar } from "./Avatar";
import type { Character, Chat, MessageLore, World } from "../../shared/domain";
import type { ModelSelection } from "../lib/providers";
import { useModelSelection } from "../lib/useModelSelection";
import { storedMessageControls, type MessageControls } from "../lib/messageControls";
import { ModelPicker, ReasoningPicker } from "./ModelPicker";
import {
  branchChat,
  createWorldCharacter,
  deleteChat,
  deleteCharacterAvatar,
  updateCharacter,
  uploadCharacterAvatar,
  type TranscriptMessage,
} from "../lib/storyApi";
import { applyWorldCharacterSaved, ensureWorldCharacters, refreshChats, refreshWorldChats, useWorldCharacters } from "../lib/libraryCache";
import type { Generation } from "../lib/useChatGeneration";
import { CharacterProfileDialog } from "./CharacterProfileDialog";
import { Narration } from "./Narration";
import { AppHeader } from "./AppHeader";
import { Composer } from "./Composer";
import { MessageScroller } from "./MessageScroller";
import { Sheet } from "./Sheet";
import { WorldPanel } from "./WorldPanel";
import { keepEscapeInFindPanel, TextEditor } from "./TextEditor";
import "./message-menu.css";

const DOCKED_QUERY = "(min-width: 80rem)";
const PANEL_COLLAPSED_KEY = "storyfold-world-panel-collapsed";

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
  characters: Character[];
  protagonistId: string;
  /** The protagonist speaks the player's turns. */
  protagonistAvatarId?: string | null;
  /** Offered on walk-on speakers; absent while a reply is running. */
  onAddToCast?: (name: string) => void;
  onShowCharacter: (characterId: string) => void;
  streaming?: boolean;
  trailing: boolean;
  lastUser: boolean;
  actionsAllowed: boolean;
  /** Generation-starting controls need the app-wide exclusivity, not just chat-level actions. */
  canGenerate: boolean;
  canBranch: boolean;
  deleteCount: number;
  onRegenerate: (direction?: string) => void;
  onSelectVariant: (messageId: string) => void;
  onEditMessage: (messageId: string, content: string, andRegenerate: boolean) => Promise<void>;
  onDeleteMessage: (messageId: string, scope?: "variant" | "after") => Promise<void>;
  onBranchMessage: (messageId: string) => Promise<void>;
  controls: MessageControls;
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
  const editorState = useRef<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState<"message" | "after" | null>(null);
  const [confirmBranch, setConfirmBranch] = useState(false);
  const [branching, setBranching] = useState(false);
  const [directing, setDirecting] = useState(false);
  const [directionValue, setDirectionValue] = useState("");

  const variantIds = message.variant_ids ?? [];
  const variantIndex = message.variant_index ?? 0;
  const trailingNarration = props.trailing && message.role === "assistant";
  const showSwipes = trailingNarration && variantIds.length > 1;
  const canAct = props.actionsAllowed;
  const canEdit = canAct && message.status === "complete";
  const canBranch = props.canBranch && !isDraft;
  const canDeleteSwipe = canAct && trailingNarration && !isDraft && variantIds.length > 1;
  const canRegenerate = props.canGenerate && trailingNarration && !isDraft;
  const canRetry = props.canGenerate && trailingNarration && (message.status === "failed" || message.status === "interrupted");
  const canDirect = props.canGenerate && props.trailing;
  // Controls stay visible while something on the row needs attention (pending draft, editor, confirmation).
  const reveal = canAct && !editing && !confirmDelete && !confirmBranch && !directing ? ` ${REVEAL_CLASSES}` : "";

  // Radix returns focus to the trigger on close; skip that when an item opens
  // an inline form, so it keeps focus and scrolls into view.
  const keepMenuFocus = useRef(false);
  const resetMenuFocus = (open: boolean) => {
    if (open) keepMenuFocus.current = false;
  };
  const skipMenuFocusReturn = (event: Event) => {
    if (!keepMenuFocus.current) return;
    keepMenuFocus.current = false;
    event.preventDefault();
  };
  const deleteConfirmRef = useRef<HTMLDivElement>(null);
  const branchConfirmRef = useRef<HTMLDivElement>(null);
  const directFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!confirmDelete) return;
    deleteConfirmRef.current?.scrollIntoView({ block: "nearest" });
    const frame = requestAnimationFrame(() => deleteConfirmRef.current?.querySelector<HTMLButtonElement>("button:last-of-type")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [confirmDelete]);
  useEffect(() => {
    if (!confirmBranch) return;
    branchConfirmRef.current?.scrollIntoView({ block: "nearest" });
    const frame = requestAnimationFrame(() => branchConfirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [confirmBranch]);
  useEffect(() => {
    if (directing) directFormRef.current?.scrollIntoView({ block: "nearest" });
  }, [directing]);
  const startEdit = () => {
    keepMenuFocus.current = true;
    setEditValue(message.content);
    editorState.current = null;
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
  const startBranch = () => {
    keepMenuFocus.current = true;
    setConfirmBranch(true);
  };
  const runBranch = () => {
    if (branching) return;
    setBranching(true);
    props.onBranchMessage(message.id).then(
      () => setConfirmBranch(false),
      () => setBranching(false), // the parent surfaces the error banner
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
      stateRef={editorState}
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
          ? `Delete this message and everything after it? This removes ${props.deleteCount} messages; the world is unchanged.`
          : "Delete this message? The world is unchanged."}
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

  const branchConfirm = confirmBranch && (
    <div
      ref={branchConfirmRef}
      className="mbs-2 grid gap-2 rounded-lg border border-border bg-surface p-3"
      role="group"
      aria-label="Confirm branching the chat from this message"
    >
      <p className="text-sm text-muted">Starts a new chat in this world with the story up to this message. This chat stays as it is.</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="pressable min-h-9 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
          onClick={runBranch}
          disabled={branching}
        >
          {branching ? "Branching…" : "Branch"}
        </button>
        <button
          type="button"
          className="pressable min-h-9 rounded-lg border border-border px-3 text-sm"
          onClick={() => setConfirmBranch(false)}
          disabled={branching}
        >
          Cancel
        </button>
      </div>
    </div>
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

  const hasActions = canAct || canBranch;
  const menu = props.controls === "menu" && hasActions && (
    <DropdownMenu.Root onOpenChange={resetMenuFocus}>
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
          onCloseAutoFocus={skipMenuFocusReturn}
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
          {canBranch && (
            <DropdownMenu.Item className="message-menu-item" onSelect={startBranch}>
              Branch from here
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  const iconButton = (label: string, Icon: LucideIcon, onClick: () => void) => (
    <button type="button" className={messageControlClasses} aria-label={label} title={label} onClick={onClick}>
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
  const inlineControls = props.controls === "inline" && hasActions && (
    <>
      {canDirect && iconButton("Regenerate with direction", MessageSquareQuote, startDirect)}
      {canEdit && iconButton("Edit", Pencil, startEdit)}
      {canBranch && iconButton("Branch from here", GitBranch, startBranch)}
      {canDeleteSwipe && iconButton("Delete swipe", Rewind, () => runDelete("variant"))}
      {canAct && (
        <DropdownMenu.Root onOpenChange={resetMenuFocus}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className={messageControlClasses} aria-label="Delete" title="Delete">
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              collisionPadding={12}
              className="message-menu-content"
              onCloseAutoFocus={skipMenuFocusReturn}
            >
              <DropdownMenu.Item className="message-menu-item" onSelect={() => startDelete("message")}>
                This message
              </DropdownMenu.Item>
              <DropdownMenu.Item className="message-menu-item" onSelect={() => startDelete("after")}>
                This and everything after
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </>
  );
  const regenerateTurn = props.trailing && props.canGenerate;

  if (message.role === "user") {
    const editingInline = editing && !editExpanded;
    return (
      <article className="group flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
          <div className="flex min-h-8 items-center gap-1 text-sm font-semibold">
            {menu && <span className={reveal}>{menu}</span>}
            <span>{message.speaker_name}</span>
          </div>
          <div className={`rounded-2xl rounded-se-md bg-accent-soft px-4 py-3 text-foreground ${editingInline ? "w-full" : "max-w-[90%]"}`}>
            {editingInline ? editForm : <p className="whitespace-pre-wrap text-[15px] leading-6">{message.content}</p>}
          </div>
          {(inlineControls || regenerateTurn) && (
            <div className={`flex items-center gap-0.5${reveal}`} role="group" aria-label="Message actions">
              {inlineControls}
              {regenerateTurn && iconButton("Regenerate reply", RefreshCw, () => props.onRegenerate())}
            </div>
          )}
          {editDialog}
          {deleteConfirm}
          {branchConfirm}
          {directForm}
        </div>
        <Avatar name={message.speaker_name} imageId={props.protagonistAvatarId} className="size-8 text-xs" />
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
      {message.lore && <ContextNote lore={message.lore} />}
      {editing && !editExpanded ? editForm : (
        content
          ? <Narration content={content} streaming={props.streaming} characters={props.characters} protagonistId={props.protagonistId} onAddToCast={props.onAddToCast} onShowCharacter={props.onShowCharacter} />
          : message.status === "pending" ? <PendingDots /> : null
      )}
      {(showSwipes || canRegenerate || canRetry || inlineControls) && (
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
          {inlineControls && (
            <div className={`flex items-center gap-0.5${reveal}`} role="group" aria-label="Message actions">
              {inlineControls}
            </div>
          )}
        </div>
      )}
      {editDialog}
      {deleteConfirm}
      {branchConfirm}
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

function ContextNote(props: { lore: MessageLore }) {
  return (
    <p className="mbs-0 mbe-2 flex items-start gap-1.5 text-xs leading-5 text-muted">
      <BookOpen className="mbs-0.5 size-3.5 flex-none" aria-hidden="true" />
      <span className="min-w-0 break-words">
        Context: {props.lore.used.join(", ") || "none"}
        {props.lore.dropped.length > 0 && ` · Over budget: ${props.lore.dropped.join(", ")}`}
      </span>
    </p>
  );
}

export function ChatPlay(props: {
  chatId: string;
  chat: Chat | null;
  world: World | null;
  chatLoading: boolean;
  chatError: string;
  messages: TranscriptMessage[] | undefined;
  messagesLoading: boolean;
  messagesError: string;
  generation: Generation | null;
  draft: string;
  onOpenSidebar: () => void;
  onDraftChange: (chatId: string, value: string) => void;
  onSend: (chatId: string, value: string, direction?: string, model?: ModelSelection) => void;
  onOpen: (chatId: string, direction?: string, model?: ModelSelection) => boolean;
  onRegenerate: (chatId: string, direction?: string, model?: ModelSelection) => boolean;
  onSelectVariant: (chatId: string, messageId: string) => Promise<void>;
  onEditMessage: (chatId: string, messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (chatId: string, messageId: string, scope?: "variant" | "after") => Promise<void>;
  onStop: (chatId: string) => void | Promise<void>;
  onRefreshMessages: (chatId: string) => void | Promise<void>;
  onRetryChat: (chatId: string) => void | Promise<void>;
  onDismissGeneration: () => void;
}) {
  const navigate = useNavigate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [walkOnName, setWalkOnName] = useState<string | null>(null);
  const [revealedCharacter, setRevealedCharacter] = useState<{ id: string; key: number } | null>(null);
  const docked = useSyncExternalStore(subscribeDocked, () => window.matchMedia(DOCKED_QUERY).matches);
  const [panelCollapsed, setPanelCollapsed] = useState(() => localStorage.getItem(PANEL_COLLAPSED_KEY) === "1");
  const [messageControls] = useState(storedMessageControls);
  const [following, setFollowing] = useState(true);
  const [actionError, setActionError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // null: the composer's direction field is closed.
  const [direction, setDirection] = useState<string | null>(null);
  const [openingDirection, setOpeningDirection] = useState("");
  const picker = useModelSelection();
  const selection = picker.selection ?? undefined;
  const messages = props.messages ?? [];
  const worldId = props.world?.id;
  const charactersLibrary = useWorldCharacters(worldId ?? "");
  const characters = charactersLibrary.items ?? [];
  const protagonist = characters.find((character) => character.id === props.chat?.protagonist_id);
  const protagonistAvatarId = protagonist?.avatar_id ?? null;
  const live = props.generation?.chatId === props.chatId ? props.generation : null;
  const otherGeneration = props.generation && props.generation.chatId !== props.chatId && props.generation.phase !== "error"
    ? props.generation
    : null;
  const otherGenerationError = props.generation
    && props.generation.chatId !== props.chatId
    && props.generation.phase === "error"
    ? props.generation
    : null;
  const hasPending = messages.some((message) => message.role === "assistant" && message.status === "pending")
    || Boolean(live?.pendingMessageId && live.phase !== "error");
  const transcriptReady = props.messages !== undefined && !props.messagesError;
  const busy = !transcriptReady || hasPending || live?.phase === "streaming" || live?.phase === "stopping" || Boolean(otherGeneration) || picker.status === "loading";
  const hasCompletedNarration = messages.some((message) => message.role === "assistant" && message.status === "complete");
  // Row actions match what the server accepts for this chat; only sends need
  // the app-wide exclusivity that `busy` tracks.
  const chatBusy = hasPending || live?.phase === "streaming" || live?.phase === "stopping";
  const actionsAllowed = transcriptReady && !chatBusy;
  // Without a usable choice the server would fall back to the saved one, which
  // may be a model the player has since switched off.
  const noModel = picker.status === "ready" && !selection;
  const canGenerate = actionsAllowed && !busy && !noModel;
  const canBranch = transcriptReady && !chatBusy;
  const lastUserMessageId = messages.filter((message) => message.role === "user").at(-1)?.id;
  const addToCast = chatBusy ? undefined : setWalkOnName;
  const showCharacter = (id: string) => {
    setRevealedCharacter((current) => ({ id, key: (current?.key ?? 0) + 1 }));
    if (!docked) setDetailsOpen(true);
  };
  const showEmptyOpening = messages.length === 0 && !busy && (!live || live.phase === "error");

  useEffect(() => {
    setFollowing(true);
  }, [props.chatId]);

  useEffect(() => {
    setActionError("");
    setDirection(null);
    setOpeningDirection("");
    setConfirmDiscard(false);
    setDiscarding(false);
  }, [props.chatId]);

  useEffect(() => {
    if (!hasPending) return;
    const refresh = () => { void props.onRefreshMessages(props.chatId); };
    const interval = window.setInterval(refresh, 3000);
    return () => window.clearInterval(interval);
  }, [hasPending, props.onRefreshMessages, props.chatId]);

  const handleSend = (value: string) => {
    setFollowing(true);
    props.onSend(props.chatId, value, direction ?? undefined, selection);
  };
  // The direction belongs to the accepted turn; a refused send keeps it for the retry.
  const acceptedTurnId = live?.kind === "message" ? live.pendingMessageId : undefined;
  useEffect(() => {
    if (acceptedTurnId) setDirection(null);
  }, [acceptedTurnId]);
  const surfaceActionError = (error: unknown) => {
    setActionError(error instanceof Error && error.message.trim() ? error.message : "That action failed. Try again.");
  };
  const handleRegenerate = (direction?: string) => {
    setActionError("");
    setFollowing(true);
    props.onRegenerate(props.chatId, direction, selection);
  };
  const handleSelectVariant = (messageId: string) => {
    setActionError("");
    props.onSelectVariant(props.chatId, messageId).catch(surfaceActionError);
  };
  const handleEditMessage = (messageId: string, content: string, andRegenerate: boolean) => {
    setActionError("");
    const saved = props.onEditMessage(props.chatId, messageId, content);
    saved.catch(surfaceActionError);
    if (!andRegenerate) return saved;
    return saved.then(() => { props.onRegenerate(props.chatId, undefined, selection); });
  };
  const handleDeleteMessage = (messageId: string, scope?: "variant" | "after") => {
    setActionError("");
    const removed = props.onDeleteMessage(props.chatId, messageId, scope);
    removed.catch(surfaceActionError);
    return removed;
  };
  const handleBranchFromMessage = (messageId: string) => {
    setActionError("");
    const branched = branchChat(props.chatId, messageId).then((branch) => {
      refreshChats();
      refreshWorldChats(branch.world_id);
      navigate(`/chats/${encodeURIComponent(branch.id)}`);
    });
    branched.catch(surfaceActionError);
    return branched;
  };
  const discardChat = async () => {
    if (!props.chat || discarding) return;
    setDiscarding(true);
    setActionError("");
    try {
      await deleteChat(props.chat.id);
      refreshChats();
      refreshWorldChats(props.chat.world_id);
      navigate(`/worlds/${encodeURIComponent(props.chat.world_id)}`);
    } catch (error) {
      surfaceActionError(error);
      setDiscarding(false);
      setConfirmDiscard(false);
    }
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
      { ...trailingMessage, status: "pending" as const, content: "", direction: live?.direction ?? null, lore: null, usage: null, variant_ids: [...kept, ""], variant_index: kept.length },
    ];
  })() : messages;
  const usageMessage = [...displayedMessages].reverse().find((message) => message.role === "assistant" && message.usage);

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

  const stopTarget = otherGeneration?.chatId ?? props.chatId;
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

  useEffect(() => {
    if (worldId) ensureWorldCharacters(worldId);
  }, [worldId]);

  const chatReady = Boolean(props.chat && props.world && charactersLibrary.items !== undefined);
  const panelProps = props.chat && props.world ? {
    chat: props.chat,
    world: props.world,
    revealCharacter: revealedCharacter,
  } : null;

  return (
    <div className="flex min-inline-0 flex-1">
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader
        title={props.chat?.title ?? "Chat"}
        subtitle={props.world?.name}
        onOpenSidebar={props.onOpenSidebar}
        actions={props.chat && (
          <>
            <Link
              to={`/worlds/${encodeURIComponent(props.chat.world_id)}`}
              className="pressable inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
            >
              <Globe2 className="size-4" aria-hidden="true" />World
            </Link>
            <button
              type="button"
              className="pressable inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              onClick={() => setConfirmDiscard(true)}
              disabled={chatBusy || discarding}
            >
              <Trash2 className="size-4" aria-hidden="true" />Discard
            </button>
            {panelProps && !docked && (
              <button type="button" className="pressable inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground" onClick={() => setDetailsOpen(true)}>
                <PanelRightOpen className="size-4" aria-hidden="true" />World
              </button>
            )}
          </>
        )}
      />

      {confirmDiscard && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 py-3 text-sm" role="group" aria-label="Confirm discarding this chat">
          <p className="min-w-0 flex-1 text-muted">Discard this chat? Its transcript is deleted; the world is unchanged.</p>
          <button
            type="button"
            className="pressable min-h-9 rounded-lg border border-border px-3 text-sm disabled:pointer-events-none disabled:opacity-50"
            onClick={() => { void discardChat(); }}
            disabled={discarding}
          >
            {discarding ? "Discarding…" : "Discard chat"}
          </button>
          <button type="button" className="pressable min-h-9 rounded-lg border border-border px-3 text-sm" onClick={() => setConfirmDiscard(false)} disabled={discarding}>Cancel</button>
        </div>
      )}

      {props.chatLoading ? (
        <p className="flex-1 px-4 py-8 text-sm text-muted" role="status">Loading chat…</p>
      ) : props.chatError || !props.chat || !props.world ? (
        <section className="m-4 grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
          <p className="text-sm text-muted">{props.chatError || "This chat could not be loaded."}</p>
          <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void props.onRetryChat(props.chatId); }}>Try again</button>
        </section>
      ) : !chatReady ? (
        charactersLibrary.loadError ? (
          <section className="m-4 grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
            <p className="text-sm text-muted">{charactersLibrary.loadError}</p>
            <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => ensureWorldCharacters(props.world!.id)}>Try again</button>
          </section>
        ) : <p className="flex-1 px-4 py-8 text-sm text-muted" role="status">Loading the world’s characters…</p>
      ) : !protagonist ? (
        <section className="m-4 grid gap-3 rounded-xl border border-border p-6" role="alert">
          <p className="text-sm text-muted">This chat’s protagonist is no longer part of {props.world.name}.</p>
        </section>
      ) : (
        <>
          {props.messagesError && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm" role="alert">
              <p className="flex-1 text-muted">{props.messagesError}</p>
              <button type="button" className="pressable min-h-9 rounded-lg border border-border px-3 text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void props.onRefreshMessages(props.chatId); }}>Retry transcript load</button>
            </div>
          )}
          {props.messagesLoading && props.messages === undefined ? (
            <p className="flex-1 px-4 py-8 text-sm text-muted" role="status">Loading transcript…</p>
          ) : (
            <MessageScroller
              key={props.chatId}
              className="flex-1"
              followOutput={following}
              followThreshold={56}
              onFollowChange={setFollowing}
              contentClassName="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6"
              label="Chat transcript"
            >
              {messages.length === 0 ? (
                <div className="my-12 grid justify-items-center gap-3 rounded-xl border border-dashed border-border px-5 py-10 text-center">
                  <Sparkles className="size-6 text-accent" aria-hidden="true" />
                  <h2 className="text-lg font-semibold">Your chat is ready</h2>
                  <p className="max-w-md text-sm text-muted">The narrator opens from the world as it stands now. Edit characters or the compendium in the world panel, then begin the opening.</p>
                  {props.chat.opening.trim() && (
                    <p className="max-h-40 w-full max-w-md overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 text-start text-sm leading-6 text-muted" aria-label="Opening">{props.chat.opening}</p>
                  )}
                  {showEmptyOpening && (
                    <form
                      className="grid w-full max-w-md gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        props.onOpen(props.chatId, openingDirection, selection);
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
                      <button type="submit" disabled={noModel} className="pressable min-h-11 justify-self-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg disabled:pointer-events-none disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90">{live?.error ? "Retry opening" : "Begin opening"}</button>
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
                  protagonistAvatarId={protagonistAvatarId}
                  onAddToCast={addToCast}
                  onShowCharacter={showCharacter}
                  trailing={index === messages.length - 1}
                  lastUser={message.id === lastUserMessageId}
                  actionsAllowed={actionsAllowed}
                  canGenerate={canGenerate}
                  protagonistId={protagonist.id}
                  canBranch={canBranch}
                  deleteCount={messages.length - index}
                  onRegenerate={handleRegenerate}
                  onSelectVariant={handleSelectVariant}
                  onEditMessage={handleEditMessage}
                  onDeleteMessage={handleDeleteMessage}
                  onBranchMessage={handleBranchFromMessage}
                  controls={messageControls}
                />
                );
              })}
              {sending && !sentListed && (
                <MessageRow
                  key="optimistic-player-turn"
                  message={{
                    id: "optimistic-player-turn",
                    chat_id: props.chatId,
                    position: messages.length + 1,
                    role: "user",
                    speaker_name: protagonist.name,
                    content: sending.playerText ?? "",
                    status: "complete",
                    direction: null,
                    lore: null,
                    usage: null,
                    created_at: "",
                    updated_at: "",
                  }}
                  trailing={false}
                  lastUser={false}
                  actionsAllowed={false}
                  canGenerate={false}
                  characters={characters}
                  protagonistAvatarId={protagonistAvatarId}
                  protagonistId={protagonist.id}
                  canBranch={false}
                  deleteCount={0}
                  onRegenerate={handleRegenerate}
                  onSelectVariant={handleSelectVariant}
                  onEditMessage={handleEditMessage}
                  onDeleteMessage={handleDeleteMessage}
                  onBranchMessage={handleBranchFromMessage}
                  controls={messageControls}
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
                {live.code === "no_provider" && <> — <Link className="font-medium text-accent underline underline-offset-2" to="/settings/providers">Add a provider in Settings</Link>.</>}
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
              Another chat is generating. <Link className="font-medium text-accent underline underline-offset-2" to={`/chats/${encodeURIComponent(otherGeneration.chatId)}`}>Open that chat</Link>, or stop its generation here.
            </p>
          )}

          {otherGenerationError?.error && (
            <p className="mx-auto w-full max-w-3xl px-4 pbe-2 text-sm text-muted" role="alert">
              Generation in another chat failed: {otherGenerationError.error}{" "}
              <Link className="font-medium text-accent underline underline-offset-2" to={`/chats/${encodeURIComponent(otherGenerationError.chatId)}`}>View that chat</Link>.
            </p>
          )}

          <Composer
            value={props.draft}
            onValueChange={(value) => props.onDraftChange(props.chatId, value)}
            onSubmit={handleSend}
            direction={direction}
            onDirectionChange={setDirection}
            modelControl={<><ModelPicker picker={picker} disabled={busy} /><ReasoningPicker picker={picker} disabled={busy} /></>}
            placeholder={`What does ${protagonist.name} do or say?`}
            inputLabel={`What does ${protagonist.name} do or say?`}
            sendLabel="Send action"
            busy={busy || noModel || !hasCompletedNarration}
            showStop={stopAvailable}
            onStop={() => { void props.onStop(stopTarget); }}
            usage={usageMessage?.usage ? { usage: usageMessage.usage, pending: usageMessage.status === "pending" } : null}
          />
        </>
      )}
    </div>
      {panelProps && (docked ? (
        <aside
          aria-label="World panel"
          className={`sidebar-shell flex-none overflow-clip border-s border-border bg-surface ${panelCollapsed ? "w-14" : "w-[24rem]"}`}
        >
          <div className={`h-full ${panelCollapsed ? "" : "w-[calc(24rem_-_1px)]"}`}>
            <WorldPanel key={panelProps.world.id} {...panelProps} collapsed={panelCollapsed} onCollapsedChange={setPanelCollapsed} />
          </div>
        </aside>
      ) : (
        <Sheet open={detailsOpen} onOpenChange={setDetailsOpen} title="World panel" closeLabel="Close world panel" className="drawer fixed inset-bs-0 inset-be-0 end-0 start-auto z-40 w-[min(100%,26rem)] border-s border-e-0 border-border bg-surface">
          <WorldPanel key={panelProps.world.id} {...panelProps} />
        </Sheet>
      ))}
      {walkOnName !== null && props.world && (
        <CharacterProfileDialog
          character={null}
          initialName={walkOnName}
          sceneContext
          title={`Add ${walkOnName} to the world`}
          description={`Adds a character to ${props.world.name}. Paragraphs tagged with this name use their profile.`}
          onCreate={(input) => createWorldCharacter(props.world!.id, input)}
          onUpdate={updateCharacter}
          onAvatarUpload={uploadCharacterAvatar}
          onAvatarRemove={deleteCharacterAvatar}
          onSaved={(saved, previousId) => applyWorldCharacterSaved(props.world!.id, saved, previousId)}
          onClose={() => setWalkOnName(null)}
        />
      )}
    </div>
  );
}
