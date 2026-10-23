import type { Campaign, CampaignStateItem, Character, Message, Relationship, RelationshipDocument, RelationshipSubject, Session, World, WorldCharacter, WorldEntry } from "../../shared/domain";
export type CampaignFork = { campaign: Campaign; session: Session };
export type CampaignRelationships = {
  subjects: RelationshipSubject[];
  relationships: Relationship[];
};

export async function fetchCampaignRelationships(campaignId: string): Promise<CampaignRelationships> {
  return request<CampaignRelationships>(`/api/campaigns/${encodeURIComponent(campaignId)}/relationships`);
}

export async function createCampaignRelationshipSubject(
  campaignId: string,
  name: string,
): Promise<RelationshipSubject> {
  return (await request<{ subject: RelationshipSubject }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/relationship-subjects`,
    { method: "POST", body: JSON.stringify({ name }) },
  )).subject;
}

export async function createCampaignRelationship(
  campaignId: string,
  input: { source_id: string; target_id: string; document: RelationshipDocument },
): Promise<Relationship> {
  return (await request<{ relationship: Relationship }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/relationships`,
    { method: "POST", body: JSON.stringify(input) },
  )).relationship;
}

export async function updateCampaignRelationship(
  campaignId: string,
  relationshipId: string,
  input: { document: RelationshipDocument },
): Promise<Relationship> {
  return (await request<{ relationship: Relationship }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/relationships/${encodeURIComponent(relationshipId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  )).relationship;
}

export async function deleteCampaignRelationship(
  campaignId: string,
  relationshipId: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/relationships/${encodeURIComponent(relationshipId)}`,
    { method: "DELETE" },
  );
}

export type CampaignStateInput = Pick<
  CampaignStateItem,
  "category" | "subject" | "content"
>;

export async function fetchCampaignState(campaignId: string): Promise<CampaignStateItem[]> {
  return (await request<{ items: CampaignStateItem[] }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/state`,
  )).items;
}

export async function createCampaignStateItem(
  campaignId: string,
  input: CampaignStateInput,
): Promise<CampaignStateItem> {
  return request<CampaignStateItem>(`/api/campaigns/${encodeURIComponent(campaignId)}/state`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateCampaignStateItem(
  campaignId: string,
  itemId: string,
  input: CampaignStateInput,
): Promise<CampaignStateItem> {
  return request<CampaignStateItem>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/state/${encodeURIComponent(itemId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export async function deleteCampaignStateItem(campaignId: string, itemId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/state/${encodeURIComponent(itemId)}`,
    { method: "DELETE" },
  );
}

export async function fetchCampaignSessions(campaignId: string): Promise<Session[]> {
  return (await request<{ sessions: Session[] }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/sessions`,
  )).sessions;
}

export async function createCampaignSession(
  campaignId: string,
  input: { title: string; handoff: string },
): Promise<Session> {
  return (await request<{ session: Session }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/sessions`,
    { method: "POST", body: JSON.stringify(input) },
  )).session;
}

export async function forkFromMessage(
  sessionId: string,
  messageId: string,
  name: string,
): Promise<CampaignFork> {
  return request<CampaignFork>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/fork`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
}

export type WorldInput = Pick<
  World,
  "name" | "setting_brief" | "suggested_starting_situation"
>;
export type CharacterInput = Pick<Character, "name" | "description">
  & Partial<Pick<Character, "appearance" | "personality" | "background" | "baseline_motivations" | "speaking_style">>;
export type CharacterPatch = Partial<CharacterInput>;

export type WorldEntryInput = Pick<WorldEntry, "kind" | "name" | "description">;
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

export async function createWorld(input: WorldInput): Promise<World> {
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

export async function fetchCharacters(): Promise<Character[]> {
  return (await request<{ characters: Character[] }>("/api/characters")).characters;
}

export async function createCharacter(input: CharacterInput): Promise<Character> {
  return (
    await request<{ character: Character }>("/api/characters", {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).character;
}

export async function updateCharacter(id: string, input: CharacterPatch): Promise<Character> {
  return (
    await request<{ character: Character }>(`/api/characters/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).character;
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

export async function listWorldCharacters(worldId: string): Promise<WorldCharacter[]> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/characters`;
  return (await request<{ characters: WorldCharacter[] }>(path)).characters;
}

export async function createWorldCharacter(
  worldId: string,
  characterId: string,
  context: string,
): Promise<WorldCharacter> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/characters`;
  return (
    await request<{ character: WorldCharacter }>(path, {
      method: "POST",
      body: JSON.stringify({ character_id: characterId, context }),
    })
  ).character;
}

export async function updateWorldCharacterContext(
  worldId: string,
  characterId: string,
  context: string,
): Promise<WorldCharacter> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/characters/${encodeURIComponent(characterId)}`;
  return (
    await request<{ character: WorldCharacter }>(path, {
      method: "PATCH",
      body: JSON.stringify({ context }),
    })
  ).character;
}

export async function deleteWorldCharacter(
  worldId: string,
  characterId: string,
): Promise<{ ok: true }> {
  const path = `/api/worlds/${encodeURIComponent(worldId)}/characters/${encodeURIComponent(characterId)}`;
  return request<{ ok: true }>(path, { method: "DELETE" });
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

export type CampaignInput = {
  world_id: string;
  protagonist_id: string;
  cast_character_ids?: string[];
  starting_situation?: string;
  name?: string;
};

export async function fetchCampaigns(): Promise<Campaign[]> {
  return (await request<{ campaigns: Campaign[] }>("/api/campaigns")).campaigns;
}

export async function createCampaign(input: CampaignInput): Promise<{ campaign: Campaign; session: Session }> {
  return request<{ campaign: Campaign; session: Session }>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  });
}


export async function fetchSession(id: string): Promise<{ session: Session; campaign: Campaign }> {
  return request<{ session: Session; campaign: Campaign }>(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function fetchSessionMessages(id: string): Promise<TranscriptMessage[]> {
  return (
    await request<{ messages: TranscriptMessage[] }>(`/api/sessions/${encodeURIComponent(id)}/messages`)
  ).messages;
}

/** Narration rows carry alternate replies; only the trailing narration has them populated. */
export type TranscriptMessage = Message & { variant_ids?: string[]; variant_index?: number };

export async function requestSessionGeneration(
  sessionId: string,
  kind: "opening" | "message" | "regenerate",
  content: string,
  model: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const path = kind === "opening"
    ? `/api/sessions/${encodeURIComponent(sessionId)}/opening`
    : kind === "regenerate"
    ? `/api/sessions/${encodeURIComponent(sessionId)}/regenerate`
    : `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
  const body = {
    ...(kind === "message" ? { content } : {}),
    ...(model ? { model } : {}),
  };
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function stopSessionGeneration(sessionId: string): Promise<{ pending: boolean; message: Message | null }> {
  return request<{ pending: boolean; message: Message | null }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
    { method: "POST" },
  );
}

export async function editSessionMessage(
  sessionId: string,
  messageId: string,
  content: string,
): Promise<Message> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`;
  return (
    await request<{ message: Message }>(path, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    })
  ).message;
}

export async function selectSessionVariant(sessionId: string, messageId: string): Promise<TranscriptMessage[]> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/select`;
  return (await request<{ messages: TranscriptMessage[] }>(path, { method: "POST" })).messages;
}

export async function deleteSessionMessage(
  sessionId: string,
  messageId: string,
  scope?: "variant" | "after",
): Promise<TranscriptMessage[]> {
  const query = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}${query}`;
  return (await request<{ messages: TranscriptMessage[] }>(path, { method: "DELETE" })).messages;
}
