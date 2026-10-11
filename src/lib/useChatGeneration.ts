import { useCallback, useRef, useState } from "react";
import { useChat } from "@tanstack/ai-react";
import { fetchProvider } from "./provider";
import type { Message } from "./types";

type GenerationPhase = "streaming" | "stopped" | "error";

/** The single in-flight reply, attached to the conversation that started it. */
export type Generation = {
  conversationId: string;
  text: string;
  phase: GenerationPhase;
  /** Safe error text, present once the phase is "error". */
  error?: string;
  /** The server reports no provider configured. */
  missingProvider?: boolean;
};

type WireMessage = Pick<Message, "role" | "content">;
type ChatRequest = {
  history: WireMessage[];
  model?: string;
};

export function useChatGeneration(options: {
  onAssistantReply: (conversationId: string, content: string) => void;
}) {
  const [generation, setGeneration] = useState<Generation | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const requestRef = useRef<ChatRequest>({ history: [] });
  const textRef = useRef("");
  const busyRef = useRef(false);
  const onAssistantReplyRef = useRef(options.onAssistantReply);
  onAssistantReplyRef.current = options.onAssistantReply;

  // Ends the run exactly once: commits whatever text exists (partial on
  // stop/failure, final on finish) and releases the single generation slot.
  const settle = useCallback((text: string): string | null => {
    const conversationId = activeIdRef.current;
    activeIdRef.current = null;
    busyRef.current = false;
    const content = text.trim() ? text : textRef.current;
    if (conversationId && content.trim()) {
      onAssistantReplyRef.current(conversationId, content);
    }
    return conversationId;
  }, []);

  const chat = useChat({
    fetcher: async (_input, { signal }) => {
      let response: Response;
      try {
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: requestRef.current.history,
            ...(requestRef.current.model
              ? { model: requestRef.current.model }
              : {}),
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(
          "Could not reach the Storyfold server. Start it with bun run dev.",
        );
      }
      if (!response.ok || !response.body) {
        let message = `The reply failed (HTTP ${response.status}).`;
        try {
          const data = (await response.json()) as { error?: unknown };
          if (typeof data.error === "string" && data.error.trim()) {
            message = data.error;
          }
        } catch {
          // Non-JSON failure body keeps the generic message.
        }
        throw new Error(message);
      }
      return response;
    },
    onChunk: (chunk) => {
      if (!busyRef.current || chunk.type !== "TEXT_MESSAGE_CONTENT") return;
      textRef.current += chunk.delta;
      setGeneration((current) =>
        current ? { ...current, text: textRef.current } : current,
      );
    },
    onFinish: (message) => {
      if (!busyRef.current) return;
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("");
      const conversationId = settle(text);
      setGeneration((current) =>
        current?.conversationId === conversationId ? null : current,
      );
    },
    onError: (error) => {
      if (!busyRef.current) return;
      const conversationId = settle(textRef.current);
      setGeneration((current) =>
        current?.conversationId === conversationId
          ? {
              ...current,
              text: textRef.current,
              phase: "error",
              error:
                error instanceof Error && error.message.trim()
                  ? error.message
                  : "The reply failed. Try again.",
            }
          : current,
      );
      fetchProvider().then(
        (config) =>
          setGeneration((current) =>
            current?.conversationId === conversationId &&
            current.phase === "error"
              ? { ...current, missingProvider: !config.has_api_key }
              : current,
          ),
        () => {},
      );
    },
  });

  const send = useCallback(
    (conversationId: string, history: WireMessage[], model?: string) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      activeIdRef.current = conversationId;
      requestRef.current = { history, model };
      textRef.current = "";
      setGeneration({ conversationId, text: "", phase: "streaming" });
      void chat
        .sendMessage(history[history.length - 1]?.content ?? "")
        .catch(() => {});
      return true;
    },
    [chat],
  );

  const stop = useCallback(() => {
    if (!busyRef.current) return;
    chat.stop();
    const partial = textRef.current;
    const conversationId = settle(partial);
    setGeneration((current) =>
      current?.conversationId === conversationId && partial.trim()
        ? { ...current, text: partial, phase: "stopped" }
        : null,
    );
  }, [chat, settle]);

  const dismiss = useCallback(() => setGeneration(null), []);

  return { generation, send, stop, dismiss };
}
