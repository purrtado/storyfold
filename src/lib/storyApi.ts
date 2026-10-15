import type { Campaign, Character, Message, Session, World, WorldCharacter, WorldEntry } from "../../shared/domain";

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
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");

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
  entry_ids?: string[];
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

export async function fetchSessionMessages(id: string): Promise<Message[]> {
  return (
    await request<{ messages: Message[] }>(`/api/sessions/${encodeURIComponent(id)}/messages`)
  ).messages;
}

export async function requestSessionGeneration(
  sessionId: string,
  kind: "opening" | "message",
  content: string,
  model: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const path = kind === "opening"
    ? `/api/sessions/${encodeURIComponent(sessionId)}/opening`
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
