import type { Conversation, Message } from "./types";
import { sampleConversations, uid } from "./samples";

export const STORAGE_KEY = "storyfold-conversations";

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Conversation[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Corrupt storage falls through to seeds.
  }
  return sampleConversations();
}

export function saveConversations(conversations: Conversation[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
}

export function newConversation(): Conversation {
  return { id: uid(), title: "New conversation", createdAt: Date.now(), messages: [] };
}

export function appendMessage(
  conversations: Conversation[],
  conversationId: string,
  message: Message,
): Conversation[] {
  return conversations.map((c) =>
    c.id === conversationId
      ? {
          ...c,
          title:
            c.messages.length === 0 && message.role === "user"
              ? message.content.slice(0, 48) + (message.content.length > 48 ? "…" : "")
              : c.title,
          messages: [...c.messages, message],
        }
      : c,
  );
}
