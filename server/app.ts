import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Chat } from "../shared/domain";
import { DATABASE_FILENAME, defaultDataDirectory } from "./config";
import { ModelCatalog } from "./models";
import {
  ProviderNotFoundError,
  ProviderStore,
  parseProviderCreate,
  parseProviderPatch,
  parseSelection,
  publicProvider,
  type ModelSelection,
} from "./providers";
import { openDatabase } from "./db";
import {
  AlreadyOpenedError,
  BusyError,
  ContextLimitError,
  NotEditableError,
  NothingToRegenerateError,
  NotTrailingError,
  PlayService,
  SoleVariantError,
  parseDirection,
  parsePlayerContent,
  type ReservedTurn,
} from "./play";
import {
  ConflictError,
  UnknownEntityError,
  ValidationError,
  clearCharacterAvatar,
  createCharacter,
  createStatDefinition,
  createWorld,
  createWorldEntry,
  deleteCharacter,
  deleteStatDefinition,
  deleteWorldEntry,
  getCharacter,
  getImage,
  getWorld,
  importWorldStats,
  listStatDefinitions,
  listWorldCharacters,
  listWorldEntries,
  listWorlds,
  IMAGE_MIME_TYPES,
  type ImageMime,
  parseCharacterInput,
  parseCharacterPatch,
  parseCharacterSceneFields,
  parseIdList,
  parseStatInput,
  parseStatPatch,
  parseWorldEntryInput,
  parseWorldEntryPatch,
  parseWorldInput,
  parseWorldPatch,
  setCharacterAvatar,
  updateCharacter,
  updateStatDefinition,
  updateWorld,
  updateWorldEntry,
} from "./worlds";
import { branchChat, createChat, deleteChat, getChat, listChats, parseChatInput, parseChatPatch, renameChat } from "./chats";
import {
  RelationshipValidationError,
  createRelationship,
  deleteRelationship,
  listRelationships,
  parseRelationshipPatch,
  updateRelationship,
} from "./relationships";
import {
  activatePromptPreset,
  createPromptCard,
  createPromptPreset,
  deletePromptCard,
  deletePromptPreset,
  listPromptCards,
  listPromptPresets,
  parsePromptCardInput,
  parsePromptCardPatch,
  parsePromptPresetInput,
  parsePromptPresetPatch,
  renamePromptPreset,
  reorderPromptCards,
  resetPromptCards,
  updatePromptCard,
} from "./promptCards";
import {
  AVATAR_BODY_MAX_BYTES,
  BODY_LIMITS,
  hasTrustedOrigin,
  isJsonContentType,
  isTrustedHost,
  jsonError,
  jsonResponse,
  preflightResponse,
  readJsonBody,
  readRawBody,
  trustedOrigin,
  withCors,
} from "./security";

export interface CreateAppOptions {
  /** Overrides the credential directory (isolated tests). */
  configDirectory?: string;
  /** Injection point for upstream provider calls, chat and /models (tests only). */
  upstreamFetch?: typeof fetch;
  /** Directory that holds storyfold.db (tests); defaults next to the credentials. */
  dataDirectory?: string;
  /** Explicit database file path (tests); wins over dataDirectory. */
  databasePath?: string;
  /** Injected open database (tests); wins over both path options. */
  database?: Database;
}

export interface App {
  fetch: (request: Request) => Promise<Response>;
  /** Releases the workspace database (test isolation). */
  close: () => void;
}

interface AppContext {
  db: Database;
  play: PlayService;
  store: ProviderStore;
  models: ModelCatalog;
  upstreamFetch: typeof fetch | undefined;
}

async function handleProviders(
  request: Request,
  id: string | undefined,
  child: string | undefined,
  ctx: AppContext,
): Promise<Response> {
  try {
    if (id === undefined) {
      if (request.method === "GET") {
        const config = await ctx.store.load();
        return jsonResponse({ providers: config.providers.map(publicProvider), selection: config.selection });
      }
      if (request.method === "POST") {
        const body = await readObjectBody(request);
        if (body instanceof Response) return body;
        const provider = await ctx.store.create(parseProviderCreate(body));
        return jsonResponse({ provider: publicProvider(provider) }, 201);
      }
      return jsonError(405, "Method not allowed");
    }
    if (child === "models") {
      if (request.method !== "GET") return jsonError(405, "Method not allowed");
      const provider = await ctx.store.get(id);
      if (!provider) return notFound("Unknown provider");
      const refresh = new URL(request.url).searchParams.get("refresh") === "1";
      return jsonResponse(await ctx.models.list(provider, { refresh }));
    }
    if (child !== undefined) return jsonError(404, "Not found");
    if (request.method === "PATCH") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      const { provider, credentialsChanged } = await ctx.store.update(id, parseProviderPatch(body));
      if (credentialsChanged) ctx.models.invalidate(id);
      return jsonResponse({ provider: publicProvider(provider) });
    }
    if (request.method === "DELETE") {
      await ctx.store.remove(id);
      ctx.models.invalidate(id);
      return jsonResponse({ ok: true });
    }
    return jsonError(405, "Method not allowed");
  } catch (error) {
    if (error instanceof ProviderNotFoundError) return notFound("Unknown provider");
    return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
  }
}

async function handleModelSelection(request: Request, ctx: AppContext): Promise<Response> {
  if (request.method !== "PUT") return jsonError(405, "Method not allowed");
  const body = await readObjectBody(request);
  if (body instanceof Response) return body;
  try {
    return jsonResponse({ selection: await ctx.store.setSelection(parseSelection(body)) });
  } catch (error) {
    if (error instanceof ProviderNotFoundError) return notFound("Unknown provider");
    return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
  }
}

function requireObjectBody(value: unknown): Record<string, unknown> | Response {
  if (typeof value !== "object" || value === null) {
    return jsonError(400, "Body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/** Maps domain rejections to their client contract; null means not a domain error. */
function domainErrorResponse(error: unknown): Response | null {
  if (error instanceof ValidationError) {
    return jsonError(400, error.message, undefined, { code: "invalid_input", accepted: false });
  }
  if (error instanceof UnknownEntityError) {
    return jsonError(404, error.message, undefined, { code: "not_found" });
  }
  if (error instanceof BusyError) {
    return jsonError(409, error.message, undefined, { code: "busy", accepted: false });
  }
  if (error instanceof AlreadyOpenedError) {
    return jsonError(409, error.message, undefined, { code: "already_opened", accepted: false });
  }
  if (error instanceof ContextLimitError) {
    return jsonError(413, error.message, undefined, { code: "context_limit", accepted: false });
  }
  if (error instanceof NothingToRegenerateError) {
    return jsonError(409, error.message, undefined, { code: "nothing_to_regenerate", accepted: false });
  }
  if (error instanceof NotTrailingError) {
    return jsonError(409, error.message, undefined, { code: "not_trailing", accepted: false });
  }
  if (error instanceof SoleVariantError) {
    return jsonError(409, error.message, undefined, { code: "sole_variant", accepted: false });
  }
  if (error instanceof NotEditableError) {
    return jsonError(409, error.message, undefined, { code: "not_editable", accepted: false });
  }
  if (error instanceof ConflictError) {
    return jsonError(409, error.message, undefined, { code: "conflict", accepted: false });
  }
  if (error instanceof RelationshipValidationError) {
    return jsonError(400, error.message, undefined, { code: "invalid_input", accepted: false });
  }
  return null;
}

/** Reads a JSON object body or the error response to send instead. */
async function readObjectBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (!isJsonContentType(request)) {
    return jsonError(415, "Content-Type must be application/json");
  }
  const body = await readJsonBody(request, BODY_LIMITS.text);
  if (!body.ok) return body.response;
  const object = requireObjectBody(body.value);
  return object;
}

function notFound(message: string): Response {
  return jsonError(404, message, undefined, { code: "not_found" });
}

async function handleWorlds(request: Request, id: string | undefined, db: Database): Promise<Response> {
  if (id === undefined) {
    if (request.method === "GET") return jsonResponse({ worlds: listWorlds(db) });
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        return jsonResponse({ world: createWorld(db, parseWorldInput(body), parseIdList(body.stat_ids, "stat_ids")) }, 201);
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (request.method === "GET") {
    const world = getWorld(db, id);
    return world ? jsonResponse({ world }) : notFound("Unknown world");
  }
  if (request.method === "PATCH") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const world = updateWorld(db, id, parseWorldPatch(body));
      return world ? jsonResponse({ world }) : notFound("Unknown world");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  return jsonError(405, "Method not allowed");
}

/** Characters are listed and created under their world; reads, edits, and deletes use /api/characters/:id. */
async function handleCharacters(request: Request, id: string | undefined, db: Database): Promise<Response> {
  if (id === undefined) return jsonError(404, "Not found");
  if (request.method === "GET") {
    const character = getCharacter(db, id);
    return character ? jsonResponse({ character }) : notFound("Unknown character");
  }
  if (request.method === "PATCH") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const character = updateCharacter(db, id, parseCharacterPatch(body));
      return character ? jsonResponse({ character }) : notFound("Unknown character");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    try {
      return deleteCharacter(db, id) ? jsonResponse({ ok: true }) : notFound("Unknown character");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  return jsonError(405, "Method not allowed");
}

/**
 * Character pictures are raw byte uploads, not multipart: the declared content
 * type must be one of the four accepted image formats, the magic bytes must
 * agree with it (SVG and everything else is rejected), and the body caps at
 * 2 MiB — the avatar route's own limit, not the JSON body cap.
 */
async function readAvatarUpload(request: Request): Promise<{ bytes: Uint8Array; mime: ImageMime } | Response> {
  const declared = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(declared)) {
    return jsonError(415, "Content-Type must be image/png, image/jpeg, image/webp, or image/gif");
  }
  const body = await readRawBody(request, AVATAR_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  if (body.data.byteLength === 0) return jsonError(400, "Request body required");
  return { bytes: body.data, mime: declared as ImageMime };
}

/** PUT is not in the generic mutating set, so the trusted-Origin rule is enforced here. */
async function handleCharacterAvatar(
  request: Request,
  id: string | undefined,
  db: Database,
): Promise<Response> {
  if (!hasTrustedOrigin(request)) return jsonError(403, "Origin not allowed");
  if (id === undefined) return notFound("Unknown character");
  const existing = getCharacter(db, id);
  if (!existing) return notFound("Unknown character");

  if (request.method === "PUT") {
    const upload = await readAvatarUpload(request);
    if (upload instanceof Response) return upload;
    try {
      const character = setCharacterAvatar(db, id, upload.bytes, upload.mime);
      return character ? jsonResponse({ character }) : notFound("Unknown character");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    const character = clearCharacterAvatar(db, id);
    return character ? jsonResponse({ character }) : notFound("Unknown character");
  }
  return jsonError(405, "Method not allowed");
}

/**
 * Images are content-addressed and immutable, so they cache forever; the
 * response mime is the stored one, never re-sniffed.
 */
function handleImageGet(request: Request, id: string | undefined, db: Database): Response {
  if (request.method !== "GET") return jsonError(405, "Method not allowed");
  if (id === undefined) return notFound("Unknown image");
  const image = getImage(db, id);
  if (!image) return notFound("Unknown image");
  return new Response(image.data, {
    headers: {
      "content-type": image.mime,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleWorldCharacters(
  request: Request,
  worldId: string | undefined,
  db: Database,
): Promise<Response> {
  if (worldId === undefined) return notFound("Unknown world");
  if (!getWorld(db, worldId)) return notFound("Unknown world");
  if (request.method === "GET") {
    return jsonResponse({ characters: listWorldCharacters(db, worldId) });
  }
  if (request.method === "POST") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const character = createCharacter(db, worldId, parseCharacterInput(body), parseCharacterSceneFields(body));
      return character ? jsonResponse({ character }, 201) : notFound("Unknown world");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  return jsonError(405, "Method not allowed");
}

/**
 * Entries are world-owned: every route carries the world id, and an entry id
 * is only ever resolved inside that scope, so another world's entry is
 * indistinguishable from a missing one.
 */
async function handleWorldEntries(
  request: Request,
  worldId: string | undefined,
  entryId: string | undefined,
  db: Database,
): Promise<Response> {
  if (worldId === undefined) return notFound("Unknown world");
  if (!getWorld(db, worldId)) return notFound("Unknown world");

  if (entryId === undefined) {
    if (request.method === "GET") return jsonResponse({ entries: listWorldEntries(db, worldId) });
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const entry = createWorldEntry(db, worldId, parseWorldEntryInput(body));
        return entry ? jsonResponse({ entry }, 201) : notFound("Unknown world");
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }

  if (request.method === "PATCH") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const entry = updateWorldEntry(db, worldId, entryId, parseWorldEntryPatch(body));
      return entry ? jsonResponse({ entry }) : notFound("Unknown entry");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    if (!deleteWorldEntry(db, worldId, entryId)) return notFound("Unknown entry");
    return jsonResponse({ ok: true });
  }
  return jsonError(405, "Method not allowed");
}

async function handleWorldRelationships(
  request: Request,
  worldId: string | undefined,
  relationshipId: string | undefined,
  db: Database,
): Promise<Response> {
  if (worldId === undefined || !getWorld(db, worldId)) return notFound("Unknown world");
  if (relationshipId === undefined) {
    if (request.method === "GET") return jsonResponse({ relationships: listRelationships(db, worldId) });
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const patch = parseRelationshipPatch(body, listStatDefinitions(db, worldId));
        return jsonResponse({ relationship: createRelationship(db, worldId, body.source_id, body.target_id, patch) }, 201);
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (request.method === "PATCH") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const patch = parseRelationshipPatch(body, listStatDefinitions(db, worldId));
      const relationship = updateRelationship(db, worldId, relationshipId, patch);
      return relationship ? jsonResponse({ relationship }) : notFound("Unknown relationship");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    return deleteRelationship(db, worldId, relationshipId) ? jsonResponse({ ok: true }) : notFound("Unknown relationship");
  }
  return jsonError(405, "Method not allowed");
}

/** Bank and world stat definitions share these routes: an id resolves in either scope. */
async function handleStats(request: Request, id: string | undefined, db: Database): Promise<Response> {
  if (id === undefined) {
    if (request.method === "GET") return jsonResponse({ stats: listStatDefinitions(db, null) });
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        return jsonResponse({ stat: createStatDefinition(db, null, parseStatInput(body)) }, 201);
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (request.method === "PATCH") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const stat = updateStatDefinition(db, id, parseStatPatch(body));
      return stat ? jsonResponse({ stat }) : notFound("Unknown stat");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    return deleteStatDefinition(db, id) ? jsonResponse({ ok: true }) : notFound("Unknown stat");
  }
  return jsonError(405, "Method not allowed");
}

/** PUT is not in the generic mutating set, so the order route enforces the trusted-Origin rule itself. */
async function handlePromptCards(request: Request, id: string | undefined, db: Database): Promise<Response> {
  try {
    if (id === undefined) {
      if (request.method === "GET") return jsonResponse({ cards: listPromptCards(db) });
      if (request.method === "POST") {
        const body = await readObjectBody(request);
        if (body instanceof Response) return body;
        return jsonResponse({ card: createPromptCard(db, parsePromptCardInput(body)) }, 201);
      }
      return jsonError(405, "Method not allowed");
    }
    if (id === "order") {
      if (request.method !== "PUT") return jsonError(405, "Method not allowed");
      if (!hasTrustedOrigin(request)) return jsonError(403, "Origin not allowed");
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      return jsonResponse({ cards: reorderPromptCards(db, body.ids) });
    }
    if (id === "reset") {
      if (request.method !== "POST") return jsonError(405, "Method not allowed");
      return jsonResponse({ cards: resetPromptCards(db) });
    }
    if (request.method === "PATCH") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      const card = updatePromptCard(db, id, parsePromptCardPatch(body));
      return card ? jsonResponse({ card }) : notFound("Unknown prompt card");
    }
    if (request.method === "DELETE") {
      return deletePromptCard(db, id) ? jsonResponse({ ok: true }) : notFound("Unknown prompt card");
    }
    return jsonError(405, "Method not allowed");
  } catch (error) {
    return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
  }
}

async function handlePromptPresets(request: Request, id: string | undefined, action: string | undefined, db: Database): Promise<Response> {
  try {
    if (id === undefined) {
      if (request.method === "GET") return jsonResponse({ presets: listPromptPresets(db) });
      if (request.method === "POST") {
        const body = await readObjectBody(request);
        if (body instanceof Response) return body;
        const preset = createPromptPreset(db, parsePromptPresetInput(body));
        return preset ? jsonResponse({ preset }, 201) : notFound("Unknown prompt preset");
      }
      return jsonError(405, "Method not allowed");
    }
    if (action === "activate") {
      if (request.method !== "POST") return jsonError(405, "Method not allowed");
      const preset = activatePromptPreset(db, id);
      return preset ? jsonResponse({ preset }) : notFound("Unknown prompt preset");
    }
    if (action !== undefined) return notFound("Not found");
    if (request.method === "PATCH") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      const preset = renamePromptPreset(db, id, parsePromptPresetPatch(body).name);
      return preset ? jsonResponse({ preset }) : notFound("Unknown prompt preset");
    }
    if (request.method === "DELETE") {
      return deletePromptPreset(db, id) ? jsonResponse({ ok: true }) : notFound("Unknown prompt preset");
    }
    return jsonError(405, "Method not allowed");
  } catch (error) {
    return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
  }
}

/** `import` copies bank stats into the world; everything else is the world's own stat list. */
async function handleWorldStats(
  request: Request,
  worldId: string | undefined,
  action: string | undefined,
  db: Database,
): Promise<Response> {
  if (worldId === undefined || !getWorld(db, worldId)) return notFound("Unknown world");
  if (action === "import") {
    if (request.method !== "POST") return jsonError(405, "Method not allowed");
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const stats = importWorldStats(db, worldId, parseIdList(body.stat_ids, "stat_ids"));
      return stats ? jsonResponse({ stats }, 201) : notFound("Unknown world");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (action !== undefined) return jsonError(404, "Not found");
  if (request.method === "GET") return jsonResponse({ stats: listStatDefinitions(db, worldId) });
  if (request.method === "POST") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      return jsonResponse({ stat: createStatDefinition(db, worldId, parseStatInput(body)) }, 201);
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  return jsonError(405, "Method not allowed");
}

/** Chats are created and listed under their world; everything else uses /api/chats/:id. */
async function handleWorldChats(request: Request, worldId: string | undefined, db: Database): Promise<Response> {
  if (worldId === undefined || !getWorld(db, worldId)) return notFound("Unknown world");
  if (request.method === "GET") return jsonResponse({ chats: listChats(db, worldId) });
  if (request.method === "POST") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const chat = createChat(db, worldId, parseChatInput(body));
      return chat ? jsonResponse({ chat }, 201) : notFound("Unknown world");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  return jsonError(405, "Method not allowed");
}

/**
 * Player turns, opening requests, and regenerations share one shape: reserve
 * input + pending reply atomically (committed before any model setup), then
 * stream. A missing provider settles the reserved reply as failed while
 * accepted input stays saved, so the composer's action is never lost and
 * never auto-retried.
 */
async function handlePlayPost(
  request: Request,
  kind: "messages" | "opening" | "regenerate",
  chatId: string,
  ctx: AppContext,
): Promise<Response> {
  const body = await readObjectBody(request);
  if (body instanceof Response) return body;

  let content = "";
  let direction: string | null;
  let requested: ModelSelection | null = null;
  try {
    if (kind === "messages") content = parsePlayerContent(body);
    direction = parseDirection(body);
    if (body.provider_id !== undefined || body.model !== undefined) requested = parseSelection(body);
  } catch (error) {
    return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
  }

  if (!getChat(ctx.db, chatId)) return notFound("Unknown chat");

  // Provider settings load before the reservation: from the first await below
  // to run registration there is no await, so reserve→register→stream is
  // atomic for the single Bun process. A Stop from another browser therefore
  // always finds the run registered, and the commit still precedes every
  // model invocation.
  const config = await ctx.store.load();
  const selection = requested ?? config.selection;
  const provider = selection
    ? config.providers.find((candidate) => candidate.id === selection.provider_id)
    : undefined;
  const reserveTurn = (chat: Chat): ReservedTurn => {
    if (kind === "messages") {
      return ctx.play.reservePlayerTurn(chatId, content, getCharacter(ctx.db, chat.protagonist_id)!.name, direction);
    }
    if (kind === "opening") {
      return ctx.play.reserveOpening(chatId, direction);
    }
    return ctx.play.reserveRegeneration(chatId, direction);
  };
  try {
    // The chat may have been discarded while the settings loaded.
    const chat = getChat(ctx.db, chatId);
    if (!chat) return notFound("Unknown chat");
    const reserved = reserveTurn(chat);
    if (!selection || !provider) {
      ctx.play.failPending(reserved.pendingId);
      return jsonError(400, "No model selected. Add a provider in Settings.", undefined, {
        code: "no_provider",
        accepted: true,
        ...(reserved.playerId !== null ? { player_message_id: reserved.playerId } : {}),
        pending_message_id: reserved.pendingId,
      });
    }
    return ctx.play.streamNarration({
      chatId,
      pendingId: reserved.pendingId,
      playerId: reserved.playerId,
      settings: { api: provider.api, baseUrl: provider.base_url, model: selection.model, apiKey: provider.api_key },
      disconnectSignal: request.signal,
      upstreamFetch: ctx.upstreamFetch,
    });
  } catch (error) {
    return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
  }
}

/** `/api/chats[/:id[/messages[/:mid[/branch|select]]|regenerate|opening|stop]]`. */
async function handleChats(request: Request, path: string[], ctx: AppContext): Promise<Response> {
  const [chatId, action, messageId, messageAction] = path;
  if (chatId === undefined) {
    if (request.method !== "GET") return jsonError(405, "Method not allowed");
    return jsonResponse({ chats: listChats(ctx.db) });
  }
  const chat = getChat(ctx.db, chatId);
  if (!chat) return notFound("Unknown chat");

  if (action === undefined) {
    if (request.method === "GET") return jsonResponse({ chat, world: getWorld(ctx.db, chat.world_id) });
    if (request.method === "PATCH") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const renamed = renameChat(ctx.db, chatId, parseChatPatch(body).title);
        return renamed ? jsonResponse({ chat: renamed }) : notFound("Unknown chat");
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    if (request.method === "DELETE") {
      try {
        if (ctx.play.hasPending(chatId)) throw new BusyError("A reply is already being generated for this chat");
        return deleteChat(ctx.db, chatId) ? jsonResponse({ ok: true }) : notFound("Unknown chat");
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (action === "messages") {
    if (messageId === undefined) {
      if (request.method === "GET") return jsonResponse({ messages: ctx.play.transcript(chatId) });
      if (request.method === "POST") return handlePlayPost(request, "messages", chatId, ctx);
      return jsonError(405, "Method not allowed");
    }
    if (messageAction === "branch" && request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const title = body.title === undefined ? undefined : parseChatPatch(body).title;
        if (ctx.play.hasPending(chatId)) throw new BusyError("A reply is already being generated for this chat");
        const branch = branchChat(ctx.db, chatId, messageId, title);
        return branch ? jsonResponse({ chat: branch }, 201) : notFound("Unknown message");
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    if (messageAction === "select" && request.method === "POST") {
      try {
        return jsonResponse({ messages: ctx.play.selectVariant(chatId, messageId) });
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    if (messageAction !== undefined) return jsonError(404, "Not found");
    if (request.method === "DELETE") {
      const scope = new URL(request.url).searchParams.get("scope");
      if (scope !== null && scope !== "variant" && scope !== "after") {
        return jsonError(400, "scope must be 'variant' or 'after'", undefined, {
          code: "invalid_input",
          accepted: false,
        });
      }
      try {
        return jsonResponse({ messages: ctx.play.deleteMessage(chatId, messageId, scope) });
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    if (request.method === "PATCH") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        return jsonResponse({ message: ctx.play.editMessage(chatId, messageId, parsePlayerContent(body)) });
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (action === "regenerate" && request.method === "POST") return handlePlayPost(request, "regenerate", chatId, ctx);
  if (action === "opening" && request.method === "POST") return handlePlayPost(request, "opening", chatId, ctx);
  if (action === "stop" && request.method === "POST") return jsonResponse(ctx.play.stop(chatId));
  return jsonError(404, "Not found");
}

async function route(request: Request, pathname: string, ctx: AppContext): Promise<Response> {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const resource = segments[1];

  // Reads are not categorically safe either: an unknown cross-site Origin is
  // rejected, while a trusted local document that sends no Origin at all keeps
  // working. Mutations additionally require the Origin header.
  const origin = request.headers.get("origin");
  if (origin !== null && trustedOrigin(request) === null) return jsonError(403, "Origin not allowed");
  const mutating =
    request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE";
  if (mutating && origin === null) return jsonError(403, "Origin not allowed");

  if (resource === "providers") return handleProviders(request, segments[2], segments[3], ctx);
  if (resource === "model-selection") return handleModelSelection(request, ctx);
  if (resource === "stats") return handleStats(request, segments[2], ctx.db);
  if (resource === "prompt-cards") return handlePromptCards(request, segments[2], ctx.db);
  if (resource === "prompt-presets") return handlePromptPresets(request, segments[2], segments[3], ctx.db);
  if (resource === "worlds") {
    if (segments[3] === "stats") return handleWorldStats(request, segments[2], segments[4], ctx.db);
    if (segments[3] === "entries") {
      return handleWorldEntries(request, segments[2], segments[4], ctx.db);
    }
    if (segments[3] === "characters") {
      return handleWorldCharacters(request, segments[2], ctx.db);
    }
    if (segments[3] === "relationships") {
      return handleWorldRelationships(request, segments[2], segments[4], ctx.db);
    }
    if (segments[3] === "chats") return handleWorldChats(request, segments[2], ctx.db);
    return handleWorlds(request, segments[2], ctx.db);
  }
  if (resource === "characters") {
    if (segments[3] === "avatar") return handleCharacterAvatar(request, segments[2], ctx.db);
    if (segments[3] !== undefined) return jsonError(404, "Not found");
    return handleCharacters(request, segments[2], ctx.db);
  }
  if (resource === "images") return handleImageGet(request, segments[2], ctx.db);
  if (resource === "chats") return handleChats(request, segments.slice(2), ctx);
  return jsonError(404, "Not found");
}

/**
 * Builds the Storyfold local API as a standalone fetch handler suitable for
 * `Bun.serve({ fetch })`. Secrets never appear in any response body, error
 * message or log line.
 */
export function createApp(options: CreateAppOptions = {}): App {
  const db =
    options.database ??
    openDatabase(
      options.databasePath ?? join(options.dataDirectory ?? defaultDataDirectory(), DATABASE_FILENAME),
    );
  const ctx: AppContext = {
    db,
    play: new PlayService(db),
    store: new ProviderStore(options.configDirectory),
    models: new ModelCatalog(options.upstreamFetch),
    upstreamFetch: options.upstreamFetch,
  };

  return {
    close: () => ctx.db.close(),
    fetch: async (request: Request): Promise<Response> => {
      let response: Response;
      try {
        if (!isTrustedHost(request)) {
          response = jsonError(403, "Untrusted host");
        } else if (request.method === "OPTIONS") {
          response = preflightResponse(request);
        } else {
          response = await route(request, new URL(request.url).pathname, ctx);
        }
      } catch {
        response = jsonError(500, "Internal server error");
      }
      return withCors(response, request);
    },
  };
}
