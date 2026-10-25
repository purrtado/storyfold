import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { protagonistOf } from "../shared/domain";
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
  SessionClosedError,
  UnknownEntityError,
  ValidationError,
  beginNextSession,
  clearCharacterAvatar,
  createCampaignStateItem,
  createCampaign,
  createCharacter,
  createWorld,
  createWorldEntry,
  copyCharacterToLibrary,
  createCampaignCharacter,
  deleteCampaignCharacter,
  deleteCharacter,
  deleteCampaignStateItem,
  deleteWorldEntry,
  forkCampaignFromMessage,
  getCampaign,
  getCharacter,
  getImage,
  getSession,
  getWorld,
  listCampaignSessions,
  listCampaignState,
  listCampaigns,
  listCharacters,
  listCampaignCharacters,
  listWorldCharacters,
  listWorldEntries,
  listWorlds,
  IMAGE_MIME_TYPES,
  type ImageMime,
  parseCampaignInput,
  parseCampaignStateInput,
  parseCampaignStatePatch,
  parseCharacterInput,
  parseCharacterPatch,
  parseForkInput,
  parseSessionCreateInput,
  parseWorldEntryInput,
  parseWorldEntryPatch,
  parseWorldInput,
  parseWorldPatch,
  setCharacterAvatar,
  updateCampaignStateItem,
  updateCharacter,
  updateWorld,
  saveCampaignCharacterToWorld,
  setCampaignCharacterAvatar,
  updateCampaignCharacter,
  updateWorldEntry,
  createCampaignStat,
  createStatDefinition,
  deleteCampaignStat,
  deleteStatDefinition,
  importCampaignStats,
  listStatDefinitions,
  parseCampaignCharacterPatch,
  parseIdList,
  parseStatInput,
  parseStatPatch,
  updateCampaignStat,
  updateStatDefinition,
} from "./library";
import {
  RelationshipValidationError,
  createRelationship,
  deleteRelationship,
  listRelationships,
  parseRelationshipPatch,
  updateRelationship,
} from "./relationships";
import {
  createPromptCard,
  deletePromptCard,
  listPromptCards,
  parsePromptCardInput,
  parsePromptCardPatch,
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
  if (error instanceof SessionClosedError) {
    return jsonError(409, error.message, undefined, { code: "session_closed", accepted: false });
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

async function handleCharacters(
  request: Request,
  id: string | undefined,
  action: string | undefined,
  db: Database,
): Promise<Response> {
  if (id === undefined) {
    if (request.method === "GET") return jsonResponse({ characters: listCharacters(db) });
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        return jsonResponse({ character: createCharacter(db, parseCharacterInput(body)) }, 201);
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (action === "copy-to-library") {
    if (request.method !== "POST") return jsonError(405, "Method not allowed");
    try {
      const character = copyCharacterToLibrary(db, id);
      return character ? jsonResponse({ character }, 201) : notFound("Unknown character");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (action !== undefined) return jsonError(404, "Not found");
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

/** World characters are listed and created under their world; edits use /api/characters/:id. */
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
      return jsonResponse({ character: createCharacter(db, parseCharacterInput(body), worldId) }, 201);
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

async function handleCampaigns(request: Request, id: string | undefined, db: Database): Promise<Response> {
  if (id === undefined) {
    if (request.method === "GET") return jsonResponse({ campaigns: listCampaigns(db) });
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        return jsonResponse(createCampaign(db, parseCampaignInput(body)), 201);
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (request.method === "GET") {
    const campaign = getCampaign(db, id);
    return campaign ? jsonResponse({ campaign }) : notFound("Unknown campaign");
  }
  return jsonError(405, "Method not allowed");
}

/**
 * Campaign state is campaign-owned manual grounding: routes carry the campaign
 * id and an item id resolves only inside it, so another campaign's item is
 * indistinguishable from a missing one. Mutations are refused while a
 * narration run is pending in the campaign's active session; nothing was
 * saved when that happens. The active session is re-read and the guard
 * re-checked after the request body arrives, so a close and pending start
 * landing inside the body read still refuse the write.
 */
async function handleCampaignState(
  request: Request,
  campaignId: string | undefined,
  itemId: string | undefined,
  ctx: AppContext,
): Promise<Response> {
  if (campaignId === undefined) return notFound("Unknown campaign");
  const campaign = getCampaign(ctx.db, campaignId);
  if (!campaign) return notFound("Unknown campaign");

  if (itemId === undefined) {
    if (request.method === "GET") {
      return jsonResponse({ items: listCampaignState(ctx.db, campaignId) });
    }
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const input = parseCampaignStateInput(body);
        const active = getCampaign(ctx.db, campaignId);
        if (!active) return notFound("Unknown campaign");
        if (ctx.play.hasPending(active.active_session_id)) throw new BusyError("A reply is already being generated for this session");
        return jsonResponse(createCampaignStateItem(ctx.db, campaignId, input), 201);
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
      const patch = parseCampaignStatePatch(body);
      const active = getCampaign(ctx.db, campaignId);
      if (!active) return notFound("Unknown campaign");
      if (ctx.play.hasPending(active.active_session_id)) throw new BusyError("A reply is already being generated for this session");
      const item = updateCampaignStateItem(ctx.db, campaignId, itemId, patch);
      return item ? jsonResponse(item) : notFound("Unknown state item");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    try {
      if (ctx.play.hasPending(campaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
      if (!deleteCampaignStateItem(ctx.db, campaignId, itemId)) return notFound("Unknown state item");
      return jsonResponse({ ok: true });
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  return jsonError(405, "Method not allowed");
}

/** Campaign writes are refused while the campaign's active session generates. */
function assertCampaignIdle(ctx: AppContext, campaignId: string): void {
  const campaign = getCampaign(ctx.db, campaignId);
  if (campaign && ctx.play.hasPending(campaign.active_session_id)) {
    throw new BusyError("A reply is already being generated for this session");
  }
}

/**
 * Campaign characters are the campaign's own copies: an id resolves only
 * inside its campaign's URL. Every write re-checks pending narration after the
 * body is read; Save to world writes only to the world.
 */
async function handleCampaignCharacters(
  request: Request,
  campaignId: string | undefined,
  characterId: string | undefined,
  action: string | undefined,
  ctx: AppContext,
): Promise<Response> {
  if (campaignId === undefined || !getCampaign(ctx.db, campaignId)) return notFound("Unknown campaign");
  if (characterId === undefined) {
    if (request.method === "GET") return jsonResponse({ characters: listCampaignCharacters(ctx.db, campaignId) });
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const input = parseCharacterInput(body);
        assertCampaignIdle(ctx, campaignId);
        return jsonResponse({ character: createCampaignCharacter(ctx.db, campaignId, input) }, 201);
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (action === "save-to-world") {
    if (request.method !== "POST") return jsonError(405, "Method not allowed");
    const character = saveCampaignCharacterToWorld(ctx.db, campaignId, characterId);
    return character ? jsonResponse({ character }, 201) : notFound("Unknown character");
  }
  if (action === "avatar") {
    if (!hasTrustedOrigin(request)) return jsonError(403, "Origin not allowed");
    if (request.method !== "PUT" && request.method !== "DELETE") return jsonError(405, "Method not allowed");
    const upload = request.method === "PUT" ? await readAvatarUpload(request) : null;
    if (upload instanceof Response) return upload;
    try {
      assertCampaignIdle(ctx, campaignId);
      const character = setCampaignCharacterAvatar(ctx.db, campaignId, characterId, upload);
      return character ? jsonResponse({ character }) : notFound("Unknown character");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (action !== undefined) return jsonError(404, "Not found");
  if (request.method === "PATCH") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const patch = parseCampaignCharacterPatch(body);
      assertCampaignIdle(ctx, campaignId);
      const character = updateCampaignCharacter(ctx.db, campaignId, characterId, patch);
      return character ? jsonResponse({ character }) : notFound("Unknown character");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    try {
      assertCampaignIdle(ctx, campaignId);
      return deleteCampaignCharacter(ctx.db, campaignId, characterId)
        ? jsonResponse({ ok: true })
        : notFound("Unknown character");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  return jsonError(405, "Method not allowed");
}

async function handleCampaignRelationships(
  request: Request,
  campaignId: string | undefined,
  relationshipId: string | undefined,
  ctx: AppContext,
): Promise<Response> {
  if (campaignId === undefined) return notFound("Unknown campaign");
  const campaign = getCampaign(ctx.db, campaignId);
  if (!campaign) return notFound("Unknown campaign");
  if (relationshipId === undefined) {
    if (request.method === "GET") return jsonResponse({ relationships: listRelationships(ctx.db, campaignId) });
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const activeCampaign = getCampaign(ctx.db, campaignId);
        if (!activeCampaign) return notFound("Unknown campaign");
        if (ctx.play.hasPending(activeCampaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
        const relationship = createRelationship(ctx.db, activeCampaign, body.source_id, body.target_id, parseRelationshipPatch(body, activeCampaign));
        return jsonResponse({ relationship }, 201);
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
      const activeCampaign = getCampaign(ctx.db, campaignId);
      if (!activeCampaign) return notFound("Unknown campaign");
      if (ctx.play.hasPending(activeCampaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
      const relationship = updateRelationship(ctx.db, activeCampaign, relationshipId, parseRelationshipPatch(body, activeCampaign));
      return relationship ? jsonResponse({ relationship }) : notFound("Unknown relationship");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    try {
      if (ctx.play.hasPending(campaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
      return deleteRelationship(ctx.db, campaignId, relationshipId) ? jsonResponse({ ok: true }) : notFound("Unknown relationship");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
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

async function handleWorldStats(request: Request, worldId: string | undefined, db: Database): Promise<Response> {
  if (worldId === undefined || !getWorld(db, worldId)) return notFound("Unknown world");
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

/**
 * Campaign stats are the campaign's own copies, listed on the campaign itself.
 * `import` copies bank stats while the story has not begun. Every write
 * re-checks pending narration after the body is read.
 */
async function handleCampaignStats(
  request: Request,
  campaignId: string | undefined,
  statId: string | undefined,
  ctx: AppContext,
): Promise<Response> {
  if (campaignId === undefined || !getCampaign(ctx.db, campaignId)) return notFound("Unknown campaign");
  if (statId === undefined || statId === "import") {
    if (request.method !== "POST") return jsonError(405, "Method not allowed");
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      if (statId === "import") {
        const ids = parseIdList(body.stat_ids, "stat_ids");
        assertCampaignIdle(ctx, campaignId);
        return jsonResponse({ stats: importCampaignStats(ctx.db, campaignId, ids) }, 201);
      }
      const input = parseStatInput(body);
      assertCampaignIdle(ctx, campaignId);
      return jsonResponse({ stat: createCampaignStat(ctx.db, campaignId, input) }, 201);
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "PATCH") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const patch = parseStatPatch(body);
      assertCampaignIdle(ctx, campaignId);
      const stat = updateCampaignStat(ctx.db, campaignId, statId, patch);
      return stat ? jsonResponse({ stat }) : notFound("Unknown stat");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    try {
      assertCampaignIdle(ctx, campaignId);
      return deleteCampaignStat(ctx.db, campaignId, statId) ? jsonResponse({ ok: true }) : notFound("Unknown stat");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  return jsonError(405, "Method not allowed");
}

/**
 * Sessions are listed in story order. POST closes the campaign's open session
 * with the reviewed handoff (checkpointing the state at that boundary) and
 * opens the next one; active_session_id moves in the same transaction. The
 * busy guard re-reads the campaign after the request body arrives, so a close
 * whose body was in flight cannot close a session that gained a pending
 * narration run meanwhile.
 */
async function handleCampaignSessions(
  request: Request,
  campaignId: string | undefined,
  ctx: AppContext,
): Promise<Response> {
  if (campaignId === undefined) return notFound("Unknown campaign");
  const campaign = getCampaign(ctx.db, campaignId);
  if (!campaign) return notFound("Unknown campaign");

  if (request.method === "GET") {
    return jsonResponse({ sessions: listCampaignSessions(ctx.db, campaignId) });
  }
  if (request.method === "POST") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const input = parseSessionCreateInput(body);
      const active = getCampaign(ctx.db, campaignId);
      if (!active) return notFound("Unknown campaign");
      if (ctx.play.hasPending(active.active_session_id)) {
        throw new BusyError("A reply is already being generated for this session");
      }
      const result = beginNextSession(ctx.db, campaignId, input);
      return result ? jsonResponse({ session: result.session }, 201) : notFound("Unknown campaign");
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
  sessionId: string,
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

  const session = getSession(ctx.db, sessionId);
  if (!session) return notFound("Unknown session");
  if (session.closed_at !== null) {
    return jsonError(
      409,
      "This session is closed; play continues in the campaign's active session",
      undefined,
      { code: "session_closed", accepted: false },
    );
  }
  const campaign = getCampaign(ctx.db, session.campaign_id);
  if (!campaign) return jsonError(500, "Internal server error");

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
  const reserveTurn = (): ReservedTurn => {
    if (kind === "messages") {
      return ctx.play.reservePlayerTurn(sessionId, content, protagonistOf(campaign).name, direction);
    }
    if (kind === "opening") {
      return ctx.play.reserveOpening(sessionId, direction);
    }
    return ctx.play.reserveRegeneration(sessionId, direction);
  };
  try {
    const reserved = reserveTurn();
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
      sessionId,
      pendingId: reserved.pendingId,
      playerId: reserved.playerId,
      settings: { baseUrl: provider.base_url, model: selection.model, apiKey: provider.api_key },
      disconnectSignal: request.signal,
      upstreamFetch: ctx.upstreamFetch,
    });
  } catch (error) {
    return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
  }
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
  if (resource === "worlds") {
    if (segments[3] === "stats") return handleWorldStats(request, segments[2], ctx.db);
    if (segments[3] === "entries") {
      return handleWorldEntries(request, segments[2], segments[4], ctx.db);
    }
    if (segments[3] === "characters") {
      return handleWorldCharacters(request, segments[2], ctx.db);
    }
    return handleWorlds(request, segments[2], ctx.db);
  }
  if (resource === "characters") {
    if (segments[3] === "avatar") return handleCharacterAvatar(request, segments[2], ctx.db);
    return handleCharacters(request, segments[2], segments[3], ctx.db);
  }
  if (resource === "images") return handleImageGet(request, segments[2], ctx.db);
  if (resource === "campaigns") {
    if (segments[3] === "state") return handleCampaignState(request, segments[2], segments[4], ctx);
    if (segments[3] === "sessions") return handleCampaignSessions(request, segments[2], ctx);
    if (segments[3] === "characters") {
      return handleCampaignCharacters(request, segments[2], segments[4], segments[5], ctx);
    }
    if (segments[3] === "stats") return handleCampaignStats(request, segments[2], segments[4], ctx);
    if (segments[3] === "relationships") {
      return handleCampaignRelationships(request, segments[2], segments[4], ctx);
    }
    return handleCampaigns(request, segments[2], ctx.db);
  }

  if (resource === "sessions" && typeof segments[2] === "string") {
    const sessionId = segments[2];
    const action = segments[3];
    if (action === undefined) {
      if (request.method === "GET") {
        const session = getSession(ctx.db, sessionId);
        if (!session) return notFound("Unknown session");
        const campaign = getCampaign(ctx.db, session.campaign_id);
        if (!campaign) return jsonError(500, "Internal server error");
        return jsonResponse({ session, campaign });
      }
      return jsonError(405, "Method not allowed");
    }
    if (action === "messages") {
      const messageId = segments[4];
      if (messageId === undefined) {
        if (request.method === "GET") {
          if (!getSession(ctx.db, sessionId)) return notFound("Unknown session");
          return jsonResponse({ messages: ctx.play.transcript(sessionId) });
        }
        if (request.method === "POST") return handlePlayPost(request, "messages", sessionId, ctx);
        return jsonError(405, "Method not allowed");
      }
      if (!getSession(ctx.db, sessionId)) return notFound("Unknown session");
      if (segments[5] === "fork" && request.method === "POST") {
        const body = await readObjectBody(request);
        if (body instanceof Response) return body;
        try {
          const session = getSession(ctx.db, sessionId);
          if (!session) return notFound("Unknown session");
          const sourceCampaign = getCampaign(ctx.db, session.campaign_id);
          if (!sourceCampaign) return jsonError(500, "Internal server error");
          if (ctx.play.hasPending(sourceCampaign.active_session_id)) {
            throw new BusyError("A reply is already being generated for this session");
          }
          const forked = forkCampaignFromMessage(ctx.db, sessionId, messageId, parseForkInput(body));
          return forked ? jsonResponse(forked, 201) : notFound("Unknown message");
        } catch (error) {
          return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
        }
      }
      if (segments[5] === "select" && request.method === "POST") {
        try {
          return jsonResponse({ messages: ctx.play.selectVariant(sessionId, messageId) });
        } catch (error) {
          return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
        }
      }
      if (segments[5] !== undefined) return jsonError(404, "Not found");
      if (request.method === "DELETE") {
        const scope = new URL(request.url).searchParams.get("scope");
        if (scope !== null && scope !== "variant" && scope !== "after") {
          return jsonError(400, "scope must be 'variant' or 'after'", undefined, {
            code: "invalid_input",
            accepted: false,
          });
        }
        try {
          return jsonResponse({ messages: ctx.play.deleteMessage(sessionId, messageId, scope) });
        } catch (error) {
          return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
        }
      }
      if (request.method === "PATCH") {
        const body = await readObjectBody(request);
        if (body instanceof Response) return body;
        try {
          return jsonResponse({ message: ctx.play.editMessage(sessionId, messageId, parsePlayerContent(body)) });
        } catch (error) {
          return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
        }
      }
      return jsonError(405, "Method not allowed");
    }
    if (action === "regenerate" && request.method === "POST") {
      return handlePlayPost(request, "regenerate", sessionId, ctx);
    }
    if (action === "opening" && request.method === "POST") {
      return handlePlayPost(request, "opening", sessionId, ctx);
    }
    if (action === "stop" && request.method === "POST") {
      if (!getSession(ctx.db, sessionId)) return notFound("Unknown session");
      return jsonResponse(ctx.play.stop(sessionId));
    }
    return jsonError(404, "Not found");
  }

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
