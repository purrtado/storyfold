import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Link } from "react-router-dom";
import { ChevronDown, Clapperboard, Copy, NotebookPen, RefreshCw, Trash2, X } from "lucide-react";
import type { Chat, ScratchMessage } from "../../shared/domain";
import { refreshScratchpad, useScratchpad } from "../lib/libraryCache";
import type { ModelSelection } from "../lib/providers";
import { clearScratchpad, deleteScratchpadMessage } from "../lib/storyApi";
import type { Generation } from "../lib/useChatGeneration";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { MessageScroller } from "./MessageScroller";
import { PendingDots, ThinkingDisclosure } from "./ReplyNotes";
import "./message-menu.css";

/** The app-level scratchpad generation: it lives above the panel, so closing the sheet never stops a reply. */
export type ScratchpadControls = {
  generation: Generation | null;
  drafts: Record<string, string>;
  onDraftChange: (chatId: string, value: string) => void;
  onSend: (chatId: string, content: string, model?: ModelSelection) => void;
  onRegenerate: (chatId: string, model?: ModelSelection) => boolean;
  onAttach: (chatId: string) => boolean;
  onStop: (chatId: string) => Promise<void>;
  onDismiss: () => void;
};

export type ScratchpadPanelProps = {
  controls: ScratchpadControls;
  model: ModelSelection | undefined;
  noModel: boolean;
  /** The story's last message is narration and a regeneration could start now. */
  canRegenerateStory: boolean;
  onUseDirection: (text: string, target: "next" | "regenerate") => void;
};

const STARTERS = [
  ["Catch me up", "Catch me up on the story so far."],
  ["What could happen next?", "What could happen next? Give me a few options."],
  ["Continuity check", "Check the story so far for continuity errors against the world."],
] as const;

const controlClasses =
  "pressable inline-flex size-7 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

const noticeClasses = "flex items-start gap-2 px-4 pbe-2 text-sm";

const dismissClasses =
  "pressable inline-flex size-8 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface";

/**
 * The chat's scratchpad: a side thread about the story with a model that
 * reads the whole world and the transcript. Nothing here reaches the
 * narrator unless the player hands a reply over as a direction.
 */
export function Scratchpad(props: ScratchpadPanelProps & { chat: Chat }) {
  const chatId = props.chat.id;
  const { controls } = props;
  const thread = useScratchpad(chatId);
  const [following, setFollowing] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [actionError, setActionError] = useState("");
  const items = thread.items ?? [];
  const live = controls.generation?.chatId === chatId ? controls.generation : null;
  const otherRunning = Boolean(controls.generation && controls.generation.chatId !== chatId && controls.generation.phase !== "error");
  const pendingStored = items.some((message) => message.status === "pending");
  const running = live?.phase === "streaming" || live?.phase === "stopping";
  const busy = pendingStored || running;

  useEffect(() => {
    void refreshScratchpad(chatId);
  }, [chatId]);

  // A reply this page is not streaming (another tab, or one from before a reload or a suspended
  // phone) still runs on the server: join it once per loaded thread; the settle refresh shows the outcome.
  const attachedThread = useRef<ScratchMessage[] | undefined>(undefined);
  const { onAttach } = controls;
  useEffect(() => {
    if (!pendingStored || controls.generation || attachedThread.current === thread.items) return;
    attachedThread.current = thread.items;
    onAttach(chatId);
  }, [pendingStored, controls.generation, thread.items, chatId, onAttach]);

  const listed = live?.pendingMessageId !== undefined && items.some((message) => message.id === live.pendingMessageId);
  const rows: ScratchMessage[] = [...items];
  if (live && running && !listed) {
    // Until the accepted rows are listed: the question asked and an empty reply.
    if (live.kind === "regenerate" && rows.at(-1)?.role === "assistant") rows.pop();
    const placeholder = { chat_id: chatId, position: 0, status: "complete" as const, reasoning: null, reasoning_ms: null, created_at: "", updated_at: "" };
    if (live.playerText !== undefined && !items.some((message) => message.id === live.playerMessageId)) {
      rows.push({ ...placeholder, id: "optimistic-question", role: "user", content: live.playerText });
    }
    rows.push({ ...placeholder, id: "optimistic-reply", role: "assistant", content: "", status: "pending" });
  }
  const lastId = rows.at(-1)?.id;

  const runAction = (action: () => Promise<unknown>) => {
    setActionError("");
    action()
      .catch((error: unknown) => setActionError(error instanceof Error && error.message.trim() ? error.message : "That action failed. Try again."))
      .finally(() => void refreshScratchpad(chatId));
  };

  return (
    <div className="flex flex-1 min-block-0 flex-col">
      <div className="flex min-h-10 flex-none items-center gap-2 px-4">
        {confirmClear ? (
          <>
            <p className="min-w-0 flex-1 text-xs text-muted">Clear the whole thread?</p>
            <button type="button" className="pressable rounded-md px-2 py-1 text-xs font-medium text-accent [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { setConfirmClear(false); runAction(() => clearScratchpad(chatId)); }}>
              Clear
            </button>
            <button type="button" className="pressable rounded-md px-2 py-1 text-xs text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <p className="min-w-0 flex-1 text-xs text-muted">Talk about the story. The narrator never sees this.</p>
            <button
              type="button"
              disabled={busy || items.length === 0}
              className="pressable rounded-md px-2 py-1 text-xs text-muted disabled:pointer-events-none disabled:opacity-40 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              onClick={() => setConfirmClear(true)}
            >
              Clear
            </button>
          </>
        )}
      </div>

      {thread.loadError ? (
        <p className="flex-1 px-4 py-3 text-sm text-muted" role="alert">{thread.loadError}</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <NotebookPen className="size-6 text-muted" aria-hidden="true" />
          <p className="max-w-60 text-sm text-muted">Ask about the story so far, the world, or where to take it next.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {STARTERS.map(([label, prompt]) => (
              <button
                key={label}
                type="button"
                onClick={() => controls.onDraftChange(chatId, prompt)}
                className="pressable rounded-full border border-border px-3 py-1.5 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <MessageScroller
          className="flex-1"
          followOutput={following}
          onFollowChange={setFollowing}
          contentClassName="flex flex-col gap-5 px-4 py-3"
          label="Scratchpad thread"
        >
          {rows.map((message) => {
            const streaming = live !== null && running && (message.id === live.pendingMessageId || message.id === "optimistic-reply");
            return message.role === "user" ? (
              <div key={message.id} className="group flex flex-col items-end gap-1">
                <p className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-se-md bg-accent-soft px-3.5 py-2.5 text-[15px] leading-6">{message.content}</p>
                {!message.id.startsWith("optimistic") && (
                  <div className="opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100">
                    <button type="button" className={controlClasses} aria-label="Delete" title="Delete" disabled={busy} onClick={() => runAction(() => deleteScratchpadMessage(chatId, message.id))}>
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <ScratchReply
                key={message.id}
                message={streaming ? { ...message, content: live.text, reasoning: live.reasoning ?? null, reasoning_ms: live.reasoningMs ?? null } : message}
                streaming={streaming}
                canRetry={message.id === lastId && !busy && !props.noModel && !otherRunning}
                canDelete={!busy}
                canRegenerateStory={props.canRegenerateStory}
                onRetry={() => {
                  setFollowing(true);
                  controls.onRegenerate(chatId, props.model);
                }}
                onDelete={() => runAction(() => deleteScratchpadMessage(chatId, message.id))}
                onUseDirection={props.onUseDirection}
              />
            );
          })}
        </MessageScroller>
      )}

      {live?.phase === "error" && live.error && (
        <div className={noticeClasses} role="alert">
          <p className="flex-1 text-muted">
            {live.error}
            {live.code === "no_provider" && <> — <Link className="font-medium text-accent underline underline-offset-2" to="/settings/providers">Add a provider in Settings</Link>.</>}
          </p>
          <button type="button" className={dismissClasses} onClick={controls.onDismiss} aria-label="Dismiss notice"><X className="size-4" aria-hidden="true" /></button>
        </div>
      )}
      {actionError && (
        <div className={noticeClasses} role="alert">
          <p className="flex-1 text-muted">{actionError}</p>
          <button type="button" className={dismissClasses} onClick={() => setActionError("")} aria-label="Dismiss notice"><X className="size-4" aria-hidden="true" /></button>
        </div>
      )}
      {otherRunning && (
        <p className="px-4 pbe-2 text-sm text-muted" role="status">Another chat's scratchpad is answering.</p>
      )}

      <Composer
        value={controls.drafts[chatId] ?? ""}
        onValueChange={(value) => controls.onDraftChange(chatId, value)}
        onSubmit={(value) => {
          setFollowing(true);
          controls.onSend(chatId, value, props.model);
        }}
        placeholder="Ask about the story…"
        inputLabel="Ask the scratchpad"
        sendLabel="Ask"
        busy={busy || otherRunning || props.noModel || thread.items === undefined}
        showStop={busy}
        onStop={() => void controls.onStop(chatId)}
      />
    </div>
  );
}

function ScratchReply(props: {
  message: ScratchMessage;
  streaming: boolean;
  canRetry: boolean;
  canDelete: boolean;
  canRegenerateStory: boolean;
  onRetry: () => void;
  onDelete: () => void;
  onUseDirection: (text: string, target: "next" | "regenerate") => void;
}) {
  const { message } = props;
  const articleRef = useRef<HTMLElement>(null);
  // Read when the menu opens: a selection inside the reply narrows the direction to that passage.
  const directionText = useRef("");
  const settled = message.status !== "pending";
  const hasText = message.content.trim().length > 0;
  const draftLabel = message.status === "interrupted" ? "Interrupted" : message.status === "failed" ? "Failed" : "";

  const captureDirection = () => {
    const selection = window.getSelection();
    const selected = selection && !selection.isCollapsed && articleRef.current?.contains(selection.anchorNode) ? selection.toString().trim() : "";
    directionText.current = selected || message.content.trim();
  };

  return (
    <article ref={articleRef} className="group">
      <div className="mbe-1 flex items-center gap-2 text-sm font-semibold">
        <NotebookPen className="size-4 text-accent" aria-hidden="true" />
        Scratchpad
        {draftLabel && <span className="text-xs font-normal text-muted">{draftLabel}</span>}
      </div>
      {message.reasoning && <ThinkingDisclosure reasoning={message.reasoning} thinking={props.streaming && !hasText} ms={message.reasoning_ms} />}
      {hasText ? (
        <div className="text-[15px] leading-6">
          <Markdown content={message.content} streaming={props.streaming} />
        </div>
      ) : !settled ? (
        <PendingDots label="The scratchpad is answering" />
      ) : null}
      {settled && (
        <div className="mbs-1.5 flex items-center gap-0.5" role="group" aria-label="Reply actions">
          {hasText && navigator.clipboard && (
            <button type="button" className={controlClasses} aria-label="Copy" title="Copy" onClick={() => void navigator.clipboard.writeText(message.content)}>
              <Copy className="size-3.5" aria-hidden="true" />
            </button>
          )}
          {hasText && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  onPointerDown={captureDirection}
                  onKeyDown={captureDirection}
                  className="pressable inline-flex min-h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-accent data-[state=open]:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                >
                  <Clapperboard className="size-3.5" aria-hidden="true" />
                  Use as direction
                  <ChevronDown className="size-3" aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={12} className="message-menu-content">
                  <DropdownMenu.Item className="message-menu-item" onSelect={() => props.onUseDirection(directionText.current, "next")}>
                    For the next reply
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="message-menu-item"
                    disabled={!props.canRegenerateStory}
                    onSelect={() => props.onUseDirection(directionText.current, "regenerate")}
                  >
                    Regenerate last reply…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          {props.canRetry && (
            <button type="button" className={controlClasses} aria-label="Retry" title="Retry" onClick={props.onRetry}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
            </button>
          )}
          <button type="button" className={controlClasses} aria-label="Delete" title="Delete" disabled={!props.canDelete} onClick={props.onDelete}>
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </article>
  );
}
