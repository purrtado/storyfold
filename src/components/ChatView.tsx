import { useEffect, useState } from "react";
import type { Conversation } from "../lib/types";
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

function MessageRow(props: { content: string; role: "user" | "assistant" }) {
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
        <Markdown content={props.content} />
      </div>
    </div>
  );
}

function ConversationView(props: {
  conversation: Conversation;
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
    </MessageScroller>
  );
}

export function ChatView(props: {
  conversation: Conversation;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (value: string) => void;
  onStarter: (text: string) => void;
  onOpenSidebar: () => void;
  onNew: () => void;
}) {
  const [following, setFollowing] = useState(true);

  // A fresh scroller mounts per conversation; re-arm the live edge so the
  // switch lands on the newest message instead of the stale scroll position.
  useEffect(() => {
    setFollowing(true);
  }, [props.conversation.id]);

  const empty = props.conversation.messages.length === 0;
  const handleSend = (value: string) => {
    setFollowing(true);
    props.onSend(value);
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
          followOutput={following}
          onFollowChange={setFollowing}
        />
      )}

      <Composer
        value={props.draft}
        onValueChange={props.onDraftChange}
        onSubmit={handleSend}
      />
    </div>
  );
}
