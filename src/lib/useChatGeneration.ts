import { useCallback, useRef, useState } from "react";
import { useChat } from "@tanstack/ai-react";
import type { ModelSelection } from "./providers";
import { ApiError, attachChatGeneration, requestChatGeneration, stopChatGeneration } from "./storyApi";

type GenerationPhase = "streaming" | "stopping" | "error";

export type Generation = {
  id: number;
  chatId: string;
  kind?: GenerationRequest["kind"];
  pendingMessageId?: string;
  playerMessageId?: string;
  /** The player text this generation was started with (kind "message"). */
  playerText?: string;
  /** The out-of-character note sent with this generation. */
  direction?: string;
  text: string;
  reasoning?: string;
  /** Set once the reply text starts after thinking: request to first reply text, as the server stores it. */
  reasoningMs?: number;
  phase: GenerationPhase;
  error?: string;
  code?: string;
};

export type AcceptedMessageIds = {
  playerMessageId?: string;
  pendingMessageId?: string;
};

type GenerationRequest = {
  id: number;
  chatId: string;
  kind: "opening" | "message" | "regenerate" | "attach";
  content: string;
  direction?: string;
  model?: ModelSelection;
};

type ErrorEnvelope = {
  error?: unknown;
  code?: unknown;
  accepted?: unknown;
  player_message_id?: unknown;
  pending_message_id?: unknown;
};

export function useChatGeneration(options: {
  onAccepted: (chatId: string, ids: AcceptedMessageIds, content: string) => void;
  onSettled: (chatId: string) => void | Promise<void>;
}) {
  const [generation, setGeneration] = useState<Generation | null>(null);
  const requestRef = useRef<GenerationRequest | null>(null);
  const activeRequestRef = useRef<GenerationRequest | null>(null);
  const textRef = useRef("");
  const reasoningRef = useRef("");
  const requestedAt = useRef(0);
  /** Set once the server accepts the request, so a dropped stream is not mistaken for a failed reply. */
  const acceptedRef = useRef(false);
  /** Set when the run itself reported a failure. */
  const runErrorRef = useRef(false);
  const busyRef = useRef(false);
  const requestSequence = useRef(0);
  const onAcceptedRef = useRef(options.onAccepted);
  const onSettledRef = useRef(options.onSettled);
  onAcceptedRef.current = options.onAccepted;
  onSettledRef.current = options.onSettled;

  const chat = useChat({
    threadId: "storyfold-generation",
    fetcher: async (_input, { signal }) => {
      const request = requestRef.current;
      if (!request) throw new Error("No chat request was prepared.");

      let response: Response;
      try {
        response = request.kind === "attach"
          ? await attachChatGeneration(request.chatId, signal)
          : await requestChatGeneration(
              request.chatId,
              request.kind,
              request.content,
              request.direction,
              request.model,
              signal,
            );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error("Could not reach the Storyfold server. Start it with bun run dev.");
      }
      // Nothing is generating any more: finish quietly and let the transcript refresh show the outcome.
      if (request.kind === "attach" && response.status === 204) return (async function* () {})();

      const headerAccepted = response.headers.get("x-storyfold-accepted") === "true";
      let envelope: ErrorEnvelope = {};
      if (!response.ok || !response.body) {
        try {
          envelope = (await response.json()) as ErrorEnvelope;
        } catch {
          envelope = {};
        }
      }
      const accepted = headerAccepted || envelope.accepted === true || (request.kind === "attach" && response.ok);
      const playerMessageId = response.headers.get("x-storyfold-player-message-id")
        ?? (typeof envelope.player_message_id === "string" ? envelope.player_message_id : undefined);
      const pendingMessageId = response.headers.get("x-storyfold-pending-message-id")
        ?? (typeof envelope.pending_message_id === "string" ? envelope.pending_message_id : undefined);
      const ids: AcceptedMessageIds = {
        ...(playerMessageId ? { playerMessageId } : {}),
        ...(pendingMessageId ? { pendingMessageId } : {}),
      };

      if (accepted) {
        acceptedRef.current = true;
        setGeneration((current) => current?.id === request.id ? { ...current, ...ids } : current);
        if (request.kind !== "attach") onAcceptedRef.current(request.chatId, ids, request.content);
      }

      if (!response.ok || !response.body) {
        throw new ApiError(
          typeof envelope.error === "string" && envelope.error.trim()
            ? envelope.error
            : `The reply failed (HTTP ${response.status}).`,
          response.status,
          typeof envelope.code === "string" ? envelope.code : undefined,
          accepted,
          playerMessageId,
          pendingMessageId,
        );
      }
      if (!accepted) {
        throw new Error("The server did not confirm that this turn was accepted.");
      }
      return response;
    },
    onChunk: (chunk) => {
      const request = activeRequestRef.current;
      if (!busyRef.current || !request) return;
      if (chunk.type === "TEXT_MESSAGE_CONTENT") {
        textRef.current += chunk.delta;
        // Thinking time is only measurable from the request this browser sent.
        const thought = request.kind !== "attach" && reasoningRef.current !== "" && textRef.current === chunk.delta;
        setGeneration((current) => current?.id === request.id
          ? { ...current, text: textRef.current, ...(thought ? { reasoningMs: Date.now() - requestedAt.current } : {}) }
          : current,
        );
      } else if (chunk.type === "REASONING_MESSAGE_CONTENT") {
        reasoningRef.current += chunk.delta;
        setGeneration((current) => current?.id === request.id
          ? { ...current, reasoning: reasoningRef.current }
          : current,
        );
      } else if (chunk.type === "RUN_ERROR") {
        runErrorRef.current = true;
        setGeneration((current) => current?.id === request.id
          ? { ...current, error: chunk.message, code: chunk.code }
          : current,
        );
      }
    },
    onFinish: () => {
      const request = activeRequestRef.current;
      if (!busyRef.current || !request) return;
      settleQuietly(request);
    },
    onError: (error) => {
      const request = activeRequestRef.current;
      if (!busyRef.current || !request) return;
      // An accepted run keeps generating on the server when the stream drops
      // (a locked phone, a suspended tab), and an attach that cannot reach it
      // changes nothing: the next transcript refresh shows the pending row,
      // which is then attached to again.
      const dropped = request.kind === "attach" || (acceptedRef.current && !(error instanceof ApiError));
      if (dropped && !runErrorRef.current) {
        settleQuietly(request);
        return;
      }
      busyRef.current = false;
      activeRequestRef.current = null;
      requestRef.current = null;
      setGeneration((current) => current?.id === request.id
        ? {
            ...current,
            phase: "error",
            error: error instanceof Error && error.message.trim()
              ? error.message
              : "The reply failed. Try again.",
            ...(error instanceof ApiError && error.code ? { code: error.code } : {}),
          }
        : current,
      );
      void onSettledRef.current(request.chatId);
    },
  });

  function settleQuietly(request: GenerationRequest): void {
    busyRef.current = false;
    activeRequestRef.current = null;
    requestRef.current = null;
    void Promise.resolve(onSettledRef.current(request.chatId)).finally(() => {
      setGeneration((current) => current?.id === request.id ? null : current);
    });
  }

  const start = useCallback((
    chatId: string,
    kind: GenerationRequest["kind"],
    content: string,
    direction?: string,
    model?: ModelSelection,
  ) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    const note = direction?.trim();
    const request = { id: ++requestSequence.current, chatId, kind, content, ...(note ? { direction: note } : {}), ...(model ? { model } : {}) };
    requestRef.current = request;
    activeRequestRef.current = request;
    textRef.current = "";
    reasoningRef.current = "";
    acceptedRef.current = false;
    runErrorRef.current = false;
    requestedAt.current = Date.now();
    chat.setMessages([]);
    setGeneration({
      id: request.id,
      chatId,
      kind,
      text: "",
      phase: "streaming",
      ...(kind === "message" ? { playerText: content } : {}),
      ...(note ? { direction: note } : {}),
    });
    // useChat reports neither finish nor error for a stream without chunks
    // (an attach answered 204), so settle whatever its callbacks left open.
    void chat.sendMessage(kind === "message" ? content : "Opening narration").catch(() => {}).finally(() => {
      if (busyRef.current && activeRequestRef.current === request) settleQuietly(request);
    });
    return true;
  }, [chat]);

  const send = useCallback((chatId: string, content: string, direction?: string, model?: ModelSelection) => {
    if (!content.trim()) return false;
    return start(chatId, "message", content, direction, model);
  }, [start]);

  const open = useCallback((chatId: string, direction?: string, model?: ModelSelection) => {
    return start(chatId, "opening", "", direction, model);
  }, [start]);

  const regenerate = useCallback((chatId: string, direction?: string, model?: ModelSelection) => {
    return start(chatId, "regenerate", "", direction, model);
  }, [start]);

  /** Joins the chat's reply still generating on the server, if any. */
  const attach = useCallback((chatId: string) => start(chatId, "attach", ""), [start]);

  const stop = useCallback(async (chatId: string) => {
    const localRequest = activeRequestRef.current?.chatId === chatId
      ? activeRequestRef.current
      : null;
    if (localRequest) {
      setGeneration((current) => current?.id === localRequest.id
        ? { ...current, phase: "stopping" }
        : current,
      );
    }

    try {
      await stopChatGeneration(chatId);
      if (localRequest && activeRequestRef.current === localRequest) {
        busyRef.current = false;
        activeRequestRef.current = null;
        requestRef.current = null;
        chat.stop();
      }
      await onSettledRef.current(chatId);
      if (localRequest) {
        setGeneration((current) => current?.id === localRequest.id ? null : current);
      }
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : "Could not stop generation.";
      setGeneration((current) => {
        if (localRequest) {
          return current?.id === localRequest.id
            ? { ...current, phase: "streaming", error: message }
            : current;
        }
        return current ?? {
          id: ++requestSequence.current,
          chatId,
          text: "",
          phase: "error",
          error: message,
        };
      });
    }
  }, [chat]);

  const dismiss = useCallback(() => {
    setGeneration((current) => current?.phase === "error" ? null : current);
  }, []);

  return { generation, send, open, regenerate, attach, stop, dismiss };
}
