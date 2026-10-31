import type { Chat, Character, CharacterProfile, Message, PromptCard, PromptPreset, Relationship, StatDefinition, StatFields, StatValues, World, WorldEntry } from "../../shared/domain";
import type { ModelSelection } from "./providers";

export type RelationshipInput = {
  source_id: string;
  target_id: string;
  how_met?: string;
  status?: string;
  known_facts?: string[];
  stats?: StatValues;
};

export type RelationshipPatch = Partial<Pick<RelationshipInput, "how_met" | "status" | "known_facts" | "stats">>;

export async function fetchWorldRelationships(worldId: string): Promise<Relationship[]> {
  return (await request<{ relationships: Relationship[] }>(
    `/api/worlds/${encodeURIComponent(worldId)}/relationships`,
  )).relationships;
}

export async function createWorldRelationship(
  worldId: string,
  input: RelationshipInput,
): Promise<Relationship> {
  return (await request<{ relationship: Relationship }>(
    `/api/worlds/${encodeURIComponent(worldId)}/relationships`,
    { method: "POST", body: JSON.stringify(input) },
  )).relationship;
}

export async function updateWorldRelationship(
  worldId: string,
  relationshipId: string,
  input: RelationshipPatch,
): Promise<Relationship> {
  return (await request<{ relationship: Relationship }>(
    `/api/worlds/${encodeURIComponent(worldId)}/relationships/${encodeURIComponent(relationshipId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  )).relationship;
}

export async function deleteWorldRelationship(
  worldId: string,
  relationshipId: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/worlds/${encodeURIComponent(worldId)}/relationships/${encodeURIComponent(relationshipId)}`,
    { method: "DELETE" },
  );
}

export type StatFieldsPatch = Partial<Omit<StatFields, "applies_to">>;

export type WorldInput = Pick<World, "name" | "setting_brief">;
export type CharacterInput = Pick<CharacterProfile, "name" | "description">
  & Partial<Omit<CharacterProfile, "name" | "description">>;
export type CharacterSceneFields = Partial<Pick<Character, "context_mode" | "summary" | "aliases" | "sticky">>;
export type CharacterCreateInput = CharacterInput & CharacterSceneFields;
export type CharacterPatch = Partial<CharacterInput> & CharacterSceneFields & {
  stats_enabled?: boolean;
  stats?: StatValues;
};

export type WorldEntryInput = Pick<WorldEntry, "kind" | "name" | "description"> & Partial<Pick<WorldEntry, "keywords" | "priority" | "sticky">>;
export type WorldEntryPatch = Partial<WorldEntryInput>;

type ApiErrorBody = {
  error?: unknown;
  code?: unknown;
  accepted?: unknown;
  player_message_id?: unknown;
  pending_message_id?: unknown;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly accepted?: boolean,
    readonly playerMessageId?: string,
    readonly pendingMessageId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Raw uploads (avatars) declare their own media type; JSON is the default.
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError("Could not reach the Storyfold server. Start it with bun run dev.", 0);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = payload && typeof payload === "object" ? (payload as ApiErrorBody) : {};
    const message = typeof body.error === "string" && body.error.trim()
      ? body.error
      : `Request failed (HTTP ${response.status}).`;
    throw new ApiError(
      message,
      response.status,
      typeof body.code === "string" ? body.code : undefined,
      body.accepted === true,
      typeof body.player_message_id === "string" ? body.player_message_id : undefined,
      typeof body.pending_message_id === "string" ? body.pending_message_id : undefined,
    );
  }

  if (payload === null) {
    throw new ApiError("The server returned an invalid response.", response.status);
  }
  return payload as T;
}

export async function fetchWorlds(): Promise<World[]> {
  return (await request<{ worlds: World[] }>("/api/worlds")).worlds;
}

/** `stat_ids` copies bank stats into the new world; only offered at creation. */
export async function createWorld(input: WorldInput & { stat_ids?: string[] }): Promise<World> {
  return (
    await request<{ world: World }>("/api/worlds", {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).world;
}

export async function updateWorld(id: string, input: WorldInput): Promise<World> {
  return (
    await request<{ world: World }>(`/api/worlds/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).world;
}

export async function updateCharacter(id: string, input: CharacterPatch): Promise<Character> {
  return (
    await request<{ character: Character }>(`/api/characters/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).character;
}

export async function deleteCharacter(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/characters/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export const AVATAR_ACCEPTED_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** Uploads the picture's raw bytes; the server rejects >2 MiB and format mismatches. */
export async function uploadCharacterAvatar(characterId: string, file: File): Promise<Character> {
  return (
    await request<{ character: Character }>(
      `/api/characters/${encodeURIComponent(characterId)}/avatar`,
      {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      },
    )
  ).character;
}

export async function deleteCharacterAvatar(characterId: string): Promise<Character> {
  return (
    await request<{ character: Character }>(
      `/api/characters/${encodeURIComponent(characterId)}/avatar`,
      { method: "DELETE" },
    )
  ).character;
}

export async function listWorldCharacters(worldId: string): Promise<Character[]> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/characters`;
  return (await request<{ characters: Character[] }>(path)).characters;
}

export async function createWorldCharacter(worldId: string, input: CharacterCreateInput): Promise<Character> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/characters`;
  return (
    await request<{ character: Character }>(path, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).character;
}

export async function listWorldEntries(worldId: string): Promise<WorldEntry[]> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/entries`;
  return (await request<{ entries: WorldEntry[] }>(path)).entries;
}

export async function createWorldEntry(worldId: string, input: WorldEntryInput): Promise<WorldEntry> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/entries`;
  return (
    await request<{ entry: WorldEntry }>(path, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).entry;
}

export async function updateWorldEntry(
  worldId: string,
  entryId: string,
  input: WorldEntryPatch,
): Promise<WorldEntry> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/entries/${encodeURIComponent(entryId)}`;
  return (
    await request<{ entry: WorldEntry }>(path, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).entry;
}

export async function deleteWorldEntry(worldId: string, entryId: string): Promise<{ ok: true }> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/entries/${encodeURIComponent(entryId)}`;
  return request<{ ok: true }>(path, { method: "DELETE" });
}

/** The stat bank: the library stats new worlds can import. */
export async function fetchStats(): Promise<StatDefinition[]> {
  return (await request<{ stats: StatDefinition[] }>("/api/stats")).stats;
}


export async function fetchPromptCards(): Promise<PromptCard[]> {
  return (await request<{ cards: PromptCard[] }>("/api/prompt-cards")).cards;
}

export async function createPromptCard(input: { title: string; body?: string; enabled?: boolean }): Promise<PromptCard> {
  return (
    await request<{ card: PromptCard }>("/api/prompt-cards", {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).card;
}

export async function updatePromptCard(
  id: string,
  patch: Partial<Pick<PromptCard, "title" | "body" | "enabled">>,
): Promise<PromptCard> {
  return (
    await request<{ card: PromptCard }>(`/api/prompt-cards/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  ).card;
}

export async function deletePromptCard(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/prompt-cards/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function orderPromptCards(ids: string[]): Promise<PromptCard[]> {
  return (await request<{ cards: PromptCard[] }>("/api/prompt-cards/order", {
    method: "PUT",
    body: JSON.stringify({ ids }),
  })).cards;
}

export async function resetPromptCards(): Promise<PromptCard[]> {
  return (await request<{ cards: PromptCard[] }>("/api/prompt-cards/reset", {
    method: "POST",
  })).cards;
}

export async function fetchPromptPresets(): Promise<PromptPreset[]> {
  return (await request<{ presets: PromptPreset[] }>("/api/prompt-presets")).presets;
}

/** The new preset becomes active; `clone_of` copies that preset's cards, null starts from the defaults. */
export async function createPromptPreset(input: { name: string; clone_of: string | null }): Promise<PromptPreset> {
  return (await request<{ preset: PromptPreset }>("/api/prompt-presets", {
    method: "POST",
    body: JSON.stringify(input),
  })).preset;
}

export async function renamePromptPreset(id: string, name: string): Promise<PromptPreset> {
  return (await request<{ preset: PromptPreset }>(`/api/prompt-presets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  })).preset;
}

export async function activatePromptPreset(id: string): Promise<PromptPreset> {
  return (await request<{ preset: PromptPreset }>(`/api/prompt-presets/${encodeURIComponent(id)}/activate`, {
    method: "POST",
  })).preset;
}

/** Deleting the active preset activates the oldest remaining one; the last preset is refused. */
export async function deletePromptPreset(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/prompt-presets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function createStat(input: StatFields): Promise<StatDefinition> {
  return (
    await request<{ stat: StatDefinition }>("/api/stats", {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).stat;
}

/** One route serves bank and world definitions alike; `applies_to` is immutable. */
export async function updateStat(id: string, patch: StatFieldsPatch): Promise<StatDefinition> {
  return (
    await request<{ stat: StatDefinition }>(`/api/stats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  ).stat;
}

export async function deleteStat(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/stats/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchWorldStats(worldId: string): Promise<StatDefinition[]> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/stats`;
  return (await request<{ stats: StatDefinition[] }>(path)).stats;
}

export async function createWorldStat(worldId: string, input: StatFields): Promise<StatDefinition> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/stats`;
  return (
    await request<{ stat: StatDefinition }>(path, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).stat;
}

export async function importWorldStats(worldId: string, statIds: string[]): Promise<StatDefinition[]> {
  return (
    await request<{ stats: StatDefinition[] }>(
      `/api/worlds/${encodeURIComponent(worldId)}/stats/import`,
      { method: "POST", body: JSON.stringify({ stat_ids: statIds }) },
    )
  ).stats;
}

export type ChatInput = { protagonist_id: string; opening?: string; title?: string };

export async function fetchChats(): Promise<Chat[]> {
  return (await request<{ chats: Chat[] }>("/api/chats")).chats;
}

export async function fetchWorldChats(worldId: string): Promise<Chat[]> {
  return (await request<{ chats: Chat[] }>(`/api/worlds/${encodeURIComponent(worldId)}/chats`)).chats;
}

export async function createChat(worldId: string, input: ChatInput): Promise<Chat> {
  return (
    await request<{ chat: Chat }>(`/api/worlds/${encodeURIComponent(worldId)}/chats`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).chat;
}

export async function fetchChat(id: string): Promise<{ chat: Chat; world: World }> {
  return request<{ chat: Chat; world: World }>(`/api/chats/${encodeURIComponent(id)}`);
}

export async function renameChat(id: string, title: string): Promise<Chat> {
  return (
    await request<{ chat: Chat }>(`/api/chats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    })
  ).chat;
}

export async function deleteChat(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function branchChat(chatId: string, messageId: string): Promise<Chat> {
  return (
    await request<{ chat: Chat }>(
      `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/branch`,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).chat;
}

export async function fetchChatMessages(id: string): Promise<TranscriptMessage[]> {
  return (
    await request<{ messages: TranscriptMessage[] }>(`/api/chats/${encodeURIComponent(id)}/messages`)
  ).messages;
}

/** Narration rows carry alternate replies; only the trailing narration has them populated. */
export type TranscriptMessage = Message & { variant_ids?: string[]; variant_index?: number };

export async function requestChatGeneration(
  chatId: string,
  kind: "opening" | "message" | "regenerate",
  content: string,
  direction: string | undefined,
  model: ModelSelection | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const path = kind === "opening"
    ? `/api/chats/${encodeURIComponent(chatId)}/opening`
    : kind === "regenerate"
    ? `/api/chats/${encodeURIComponent(chatId)}/regenerate`
    : `/api/chats/${encodeURIComponent(chatId)}/messages`;
  const body = {
    ...(kind === "message" ? { content } : {}),
    ...(direction ? { direction } : {}),
    ...(model ? { provider_id: model.provider_id, model: model.model } : {}),
  };
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** The chat's reply still generating on the server as SSE, or `204` when there is none. */
export async function attachChatGeneration(chatId: string, signal: AbortSignal): Promise<Response> {
  return fetch(`/api/chats/${encodeURIComponent(chatId)}/generation`, { signal });
}

export async function stopChatGeneration(chatId: string): Promise<{ pending: boolean; message: Message | null }> {
  return request<{ pending: boolean; message: Message | null }>(
    `/api/chats/${encodeURIComponent(chatId)}/stop`,
    { method: "POST" },
  );
}

export async function editChatMessage(
  chatId: string,
  messageId: string,
  content: string,
): Promise<Message> {
  const path = `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`;
  return (
    await request<{ message: Message }>(path, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    })
  ).message;
}

export async function selectChatVariant(chatId: string, messageId: string): Promise<TranscriptMessage[]> {
  const path = `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/select`;
  return (await request<{ messages: TranscriptMessage[] }>(path, { method: "POST" })).messages;
}

export async function deleteChatMessage(
  chatId: string,
  messageId: string,
  scope?: "variant" | "after",
): Promise<TranscriptMessage[]> {
  const query = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const path = `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}${query}`;
  return (await request<{ messages: TranscriptMessage[] }>(path, { method: "DELETE" })).messages;
}
