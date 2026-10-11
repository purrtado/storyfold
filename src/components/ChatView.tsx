import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { fetchProvider, type ProviderConfig } from "../lib/provider";
import type { Conversation } from "../lib/types";
import type { Generation } from "../lib/useChatGeneration";
import { Markdown } from "./Markdown";
import { PlusIcon } from "./icons";
import { AppHeader } from "./AppHeader";
import { Composer } from "./Composer";
import { MessageScroller } from "./MessageScroller";

const starters = [
  {
    label: "Explore an idea",
    prompt:
      "Explore an idea with me: what would change if people could revisit a single day of their past?",
  },
  {
    label: "Clarify an idea",
    prompt:
      "Help me make something clear — I'll share rough notes and you ask questions until the main point stands out.",
  },
  {
    label: "Start writing",
    prompt:
      "Start writing with me: open with a stranger who boards the last night train carrying only a letter.",
  },
];

function Welcome(props: { onStarter: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Where should we begin?
        </h1>
        <p className="mbs-1 text-muted">
          A question, an idea, or a blank page.
        </p>
      </div>
      <div className="grid w-full max-w-xl gap-2 sm:grid-cols-3">
        {starters.map((starter) => (
          <button
            key={starter.label}
            type="button"
            className="pressable w-full cursor-pointer rounded-xl border border-border bg-raised px-4 py-3 text-center text-sm hover:border-accent"
            onClick={() => props.onStarter(starter.prompt)}
          >
            <span className="font-medium">{starter.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PendingDots() {
  return (
    <p className="flex items-center gap-1 py-1" role="status" aria-label="Assistant is responding">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 motion-safe:animate-pulse rounded-full bg-muted"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </p>
  );
}

function MessageRow(props: {
  content: string;
  role: "user" | "assistant";
  streaming?: boolean;
}) {
  if (props.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-ee-md bg-accent-soft px-4 py-2.5 text-[15px] whitespace-pre-wrap text-foreground">
          {props.content}
        </p>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-full">
        {props.content ? (
          <Markdown content={props.content} streaming={props.streaming} />
        ) : props.streaming ? (
          <PendingDots />
        ) : null}
      </div>
    </div>
  );
}

function ConversationView(props: {
  conversation: Conversation;
  live: Generation | null;
  followOutput: boolean;
  onFollowChange: (following: boolean) => void;
}) {
  return (
    <MessageScroller
      className="flex-1"
      followOutput={props.followOutput}
      followThreshold={56}
      onFollowChange={props.onFollowChange}
      contentClassName="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6"
      label="Conversation"
    >
      {props.conversation.messages.map((m) => (
        <MessageRow key={m.id} role={m.role} content={m.content} />
      ))}
      {props.live && (
        <MessageRow
          role="assistant"
          content={props.live.text}
          streaming={props.live.phase === "streaming"}
        />
      )}
    </MessageScroller>
  );
}

export function ChatView(props: {
  conversation: Conversation;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (value: string, model?: string) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  onStarter: (text: string) => void;
  onOpenSidebar: () => void;
  onNew: () => void;
  generation: Generation | null;
  onStop: () => void;
  onDismissGeneration: () => void;
}) {
  const [following, setFollowing] = useState(true);
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [modelCatalogState, setModelCatalogState] = useState<
    "loading" | "ready" | "error"
  >("loading");

  useEffect(() => {
    let canceled = false;
    fetchProvider().then(
      (loaded) => {
        if (canceled) return;
        setProvider(loaded);
        setModelCatalogState("ready");
      },
      () => {
        if (!canceled) setModelCatalogState("error");
      },
    );
    return () => {
      canceled = true;
    };
  }, []);

  // A fresh scroller mounts per conversation; re-arm the live edge so the
  // switch lands on the newest message instead of the stale scroll position.
  useEffect(() => {
    setFollowing(true);
  }, [props.conversation.id]);

  const live =
    props.generation &&
    props.generation.conversationId === props.conversation.id
      ? props.generation
      : null;
  const busy = props.generation?.phase === "streaming";
  const selectedModel =
    modelCatalogState === "ready" &&
    provider?.models.some((model) => model.id === props.selectedModel)
      ? props.selectedModel
      : "";

  const empty = props.conversation.messages.length === 0 && !live;
  const handleSend = (value: string) => {
    setFollowing(true);
    props.onSend(value, selectedModel || undefined);
  };
  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader
        title={props.conversation.title}
        onOpenSidebar={props.onOpenSidebar}
        actions={
          <button
            type="button"
            className="hit-44 pressable inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-foreground md:hidden"
            onClick={props.onNew}
            aria-label="New conversation"
          >
            <PlusIcon />
          </button>
        }
      />

      {empty ? (
        <Welcome onStarter={props.onStarter} />
      ) : (
        <ConversationView
          key={props.conversation.id}
          conversation={props.conversation}
          live={live?.phase === "streaming" ? live : null}
          followOutput={following}
          onFollowChange={setFollowing}
        />
      )}

      {live && live.phase !== "streaming" && (
        <GenerationNotice
          phase={live.phase}
          error={live.error}
          missingProvider={live.missingProvider}
          onDismiss={props.onDismissGeneration}
        />
      )}

      <Composer
        value={props.draft}
        onValueChange={props.onDraftChange}
        onSubmit={handleSend}
        selectedModel={selectedModel}
        onModelChange={props.onModelChange}
        defaultModel={provider?.model ?? null}
        models={provider?.models ?? []}
        modelCatalogState={modelCatalogState}
        busy={busy}
        showStop={live?.phase === "streaming"}
        onStop={props.onStop}
      />
    </div>
  );
}

function GenerationNotice(props: {
  phase: "stopped" | "error";
  error?: string;
  missingProvider?: boolean;
  onDismiss: () => void;
}) {
  const error = props.phase === "error";
  return (
    <div
      role={error ? "alert" : "status"}
      className="mx-auto flex w-full max-w-3xl items-start gap-2 px-4 [padding-block-end:0.25rem] text-sm"
    >
      <p className="flex-1 text-muted">
        {error
          ? (props.error ?? "The reply failed. Try again.")
          : "Stopped — the partial reply was kept."}
        {props.missingProvider && (
          <>
            {" "}
            No provider is configured —{" "}
            <Link
              to="/settings/providers"
              className="font-medium text-accent underline underline-offset-2"
            >
              set up Z.AI in Settings
            </Link>
            .
          </>
        )}
      </p>
      <button
        type="button"
        className="hit-44 pressable -me-1 inline-flex size-7 flex-none cursor-pointer items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
        onClick={props.onDismiss}
        aria-label="Dismiss notice"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
