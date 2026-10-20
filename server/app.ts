import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  CredentialStore,
  DATABASE_FILENAME,
  defaultDataDirectory,
  publicConfig,
  validateApiKey,
  validateModel,
} from "./config";
import { openDatabase } from "./db";
import {
  AlreadyOpenedError,
  BusyError,
  ContextLimitError,
  PlayService,
  parsePlayerContent,
  type ReservedTurn,
} from "./play";
import {
  SessionClosedError,
  SessionNotClosedError,
  UnknownEntityError,
  ValidationError,
  associateWorldCharacter,
  beginNextSession,
  clearCharacterAvatar,
  createCampaignStateItem,
  createCampaign,
  createCharacter,
  createWorld,
  createWorldEntry,
  deleteWorldCharacter,
  deleteCampaignStateItem,
  deleteWorldEntry,
  forkCampaignFromSession,
  getCampaign,
  getCharacter,
  getImage,
  getSession,
  getWorld,
  listCampaignSessions,
  listCampaignState,
  listCampaigns,
  listCharacters,
  listWorldCharacters,
  listWorldEntries,
  listWorlds,
  IMAGE_MIME_TYPES,
  parseCampaignInput,
  parseCampaignStateInput,
  parseCampaignStatePatch,
  parseCharacterInput,
  parseCharacterPatch,
  parseForkInput,
  parseSessionCreateInput,
  parseWorldCharacterInput,
  parseWorldCharacterPatch,
  parseWorldEntryInput,
  parseWorldEntryPatch,
  parseWorldInput,
  parseWorldPatch,
  setCharacterAvatar,
  updateCampaignStateItem,
  updateCharacter,
  updateWorld,
  updateWorldCharacter,
  updateWorldEntry,
} from "./library";
import {
  RelationshipConflictError,
  RelationshipValidationError,
  appendRelationshipEvent,
  createRelationship,
  createRelationshipSubject,
  deleteRelationship,
  listRelationshipEvents,
  listRelationships,
  parseRelationshipDocument,
  updateRelationship,
} from "./relationships";
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
  /** Injection point for the Z.AI upstream call (tests only). */
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
  store: CredentialStore;
  upstreamFetch: typeof fetch | undefined;
}

async function handleProviderGet(request: Request, store: CredentialStore): Promise<Response> {
  // GET carries no secrets, but an untrusted cross-site document must not be
  // able to probe the endpoint; a trusted tab navigating directly sends no
  // Origin at all and stays allowed.
  const origin = request.headers.get("origin");
  if (origin !== null && trustedOrigin(request) === null) {
    return jsonError(403, "Origin not allowed");
  }
  return jsonResponse(publicConfig(await store.load()));
}

async function handleProviderPut(request: Request, store: CredentialStore): Promise<Response> {
  if (!isJsonContentType(request)) {
    return jsonError(415, "Content-Type must be application/json");
  }
  const body = await readJsonBody(request, BODY_LIMITS.provider);
  if (!body.ok) return body.response;
  const object = requireObjectBody(body.value);
  if (object instanceof Response) return object;

  const { model, api_key } = object;
  const modelError = validateModel(model);
  if (modelError) return jsonError(400, modelError);
  if (api_key === undefined && (await store.load()) === null) {
    return jsonError(400, "api_key is required for a new configuration");
  }
  if (api_key !== undefined) {
    const keyError = validateApiKey(api_key);
    if (keyError) return jsonError(400, keyError);
  }

  await store.save({
    model: model as string,
    ...(api_key !== undefined ? { api_key: api_key as string } : {}),
  });
  return jsonResponse(publicConfig(await store.load()));
}

async function handleProviderDelete(_request: Request, store: CredentialStore): Promise<Response> {
  await store.remove();
  return jsonResponse(publicConfig(null));
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
  if (error instanceof SessionClosedError) {
    return jsonError(409, error.message, undefined, { code: "session_closed", accepted: false });
  }
  if (error instanceof SessionNotClosedError) {
    return jsonError(409, error.message, undefined, { code: "session_not_closed", accepted: false });
  }
  if (error instanceof RelationshipValidationError) {
    return jsonError(400, error.message, undefined, { code: "invalid_input", accepted: false });
  }
  if (error instanceof RelationshipConflictError) {
    return jsonError(409, error.message, undefined, { code: "conflict" });
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
        return jsonResponse({ world: createWorld(db, parseWorldInput(body)) }, 201);
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

async function handleCharacters(request: Request, id: string | undefined, db: Database): Promise<Response> {
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
  return jsonError(405, "Method not allowed");
}

/**
 * Character pictures are raw byte uploads, not multipart: the declared content
 * type must be one of the four accepted image formats, the magic bytes must
 * agree with it (SVG and everything else is rejected), and the body caps at
 * 2 MiB — the avatar route's own limit, not the JSON body cap. PUT is not in
 * the generic mutating set, so the trusted-Origin rule is enforced here.
 */
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
    const declared = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!(IMAGE_MIME_TYPES as readonly string[]).includes(declared)) {
      return jsonError(415, "Content-Type must be image/png, image/jpeg, image/webp, or image/gif");
    }
    const body = await readRawBody(request, AVATAR_BODY_MAX_BYTES);
    if (!body.ok) return body.response;
    if (body.data.byteLength === 0) return jsonError(400, "Request body required");
    try {
      const character = setCharacterAvatar(db, id, body.data, declared as (typeof IMAGE_MIME_TYPES)[number]);
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

/**
 * World cast is world-scoped like entries: every route carries the world id,
 * and a character id is only ever resolved inside that scope, so another
 * world's association is indistinguishable from a missing one.
 */
async function handleWorldCharacters(
  request: Request,
  worldId: string | undefined,
  characterId: string | undefined,
  db: Database,
): Promise<Response> {
  if (worldId === undefined) return notFound("Unknown world");
  if (!getWorld(db, worldId)) return notFound("Unknown world");

  if (characterId === undefined) {
    if (request.method === "GET") {
      return jsonResponse({ characters: listWorldCharacters(db, worldId) });
    }
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const association = associateWorldCharacter(db, worldId, parseWorldCharacterInput(body));
        return association ? jsonResponse({ character: association }, 201) : notFound("Unknown world");
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
      const association = updateWorldCharacter(db, worldId, characterId, parseWorldCharacterPatch(body));
      return association ? jsonResponse({ character: association }) : notFound("Unknown character");
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (request.method === "DELETE") {
    if (!deleteWorldCharacter(db, worldId, characterId)) return notFound("Unknown character");
    return jsonResponse({ ok: true });
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
 * saved when that happens.
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
        if (ctx.play.hasPending(campaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
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
      if (ctx.play.hasPending(campaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
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
async function handleCampaignRelationships(
  request: Request,
  campaignId: string | undefined,
  relationshipId: string | undefined,
  action: string | undefined,
  ctx: AppContext,
): Promise<Response> {
  if (campaignId === undefined) return notFound("Unknown campaign");
  const campaign = getCampaign(ctx.db, campaignId);
  if (!campaign) return notFound("Unknown campaign");
  if (action === "events" && relationshipId !== undefined) {
    if (request.method === "GET") {
      const events = listRelationshipEvents(ctx.db, campaignId, relationshipId);
      return events ? jsonResponse({ events }) : notFound("Unknown relationship");
    }
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const activeCampaign = getCampaign(ctx.db, campaignId);
        if (!activeCampaign) return notFound("Unknown campaign");
        if (ctx.play.hasPending(activeCampaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
        const event = appendRelationshipEvent(ctx.db, activeCampaign, relationshipId, body.description as string);
        return event ? jsonResponse({ event }, 201) : notFound("Unknown relationship");
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
    return jsonError(405, "Method not allowed");
  }
  if (relationshipId === undefined && action === "relationship-subjects" && request.method === "POST") {
    const body = await readObjectBody(request);
    if (body instanceof Response) return body;
    try {
      const activeCampaign = getCampaign(ctx.db, campaignId);
      if (!activeCampaign) return notFound("Unknown campaign");
      if (ctx.play.hasPending(activeCampaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
      return jsonResponse({ subject: createRelationshipSubject(ctx.db, campaignId, body.name as string) }, 201);
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  if (relationshipId === undefined) {
    if (request.method === "GET") return jsonResponse(listRelationships(ctx.db, campaign));
    if (request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const activeCampaign = getCampaign(ctx.db, campaignId);
        if (!activeCampaign) return notFound("Unknown campaign");
        if (ctx.play.hasPending(activeCampaign.active_session_id)) throw new BusyError("A reply is already being generated for this session");
        const relationship = createRelationship(ctx.db, activeCampaign, body.source_id as string, body.target_id as string, parseRelationshipDocument(body.document));
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
      const relationship = updateRelationship(ctx.db, activeCampaign, relationshipId, parseRelationshipDocument(body.document), body.revision as number);
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


/**
 * Sessions are listed in story order. POST closes the campaign's open session
 * with the reviewed handoff (checkpointing the state at that boundary) and
 * opens the next one; active_session_id moves in the same transaction.
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
      if (ctx.play.hasPending(campaign.active_session_id)) {
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
 * Player turns and opening requests share one shape: reserve input + pending
 * reply atomically (committed before any model setup), then stream. A missing
 * provider settles the reserved reply as failed while accepted input stays
 * saved, so the composer's action is never lost and never auto-retried.
 */
async function handlePlayPost(
  request: Request,
  kind: "messages" | "opening",
  sessionId: string,
  ctx: AppContext,
): Promise<Response> {
  const body = await readObjectBody(request);
  if (body instanceof Response) return body;

  let content = "";
  if (kind === "messages") {
    try {
      content = parsePlayerContent(body);
    } catch (error) {
      return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
    }
  }
  let model: string | undefined;
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || validateModel(body.model) !== null) {
      return jsonError(400, "model must be 1-128 characters of letters, digits, dot, underscore, colon or dash", undefined, { code: "invalid_input", accepted: false });
    }
    model = body.model;
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
  const settings = await ctx.store.load();
  const reserveTurn = (): ReservedTurn => {
    if (kind === "messages") {
      return ctx.play.reservePlayerTurn(sessionId, content, campaign.protagonist_snapshot.name);
    }
    return ctx.play.reserveOpening(sessionId);
  };
  try {
    const reserved = reserveTurn();
    if (settings === null) {
      ctx.play.failPending(reserved.pendingId);
      return jsonError(400, "No provider API key configured. Add one in Settings.", undefined, {
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
      campaign,
      settings: { model: model ?? settings.model, apiKey: settings.api_key },
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

  if (pathname === "/api/provider") {
    if (request.method === "GET") return handleProviderGet(request, ctx.store);
    if (request.method === "PUT" || request.method === "DELETE") {
      if (!hasTrustedOrigin(request)) return jsonError(403, "Origin not allowed");
      return request.method === "PUT"
        ? handleProviderPut(request, ctx.store)
        : handleProviderDelete(request, ctx.store);
    }
    return jsonError(405, "Method not allowed");
  }

  // Domain reads are not categorically safe either: an unknown cross-site
  // Origin is rejected exactly like the provider GET, while a trusted local
  // document that sends no Origin at all keeps working. Mutations additionally
  // require the Origin header (hasTrustedOrigin).
  const origin = request.headers.get("origin");
  if (origin !== null && trustedOrigin(request) === null) return jsonError(403, "Origin not allowed");
  const mutating = request.method === "POST" || request.method === "PATCH" || request.method === "DELETE";
  if (mutating && origin === null) return jsonError(403, "Origin not allowed");

  if (resource === "worlds") {
    if (segments[3] === "entries") {
      return handleWorldEntries(request, segments[2], segments[4], ctx.db);
    }
    if (segments[3] === "characters") {
      return handleWorldCharacters(request, segments[2], segments[4], ctx.db);
    }
    return handleWorlds(request, segments[2], ctx.db);
  }
  if (resource === "characters") {
    if (segments[3] === "avatar") return handleCharacterAvatar(request, segments[2], ctx.db);
    return handleCharacters(request, segments[2], ctx.db);
  }
  if (resource === "images") return handleImageGet(request, segments[2], ctx.db);
  if (resource === "campaigns") {
    if (segments[3] === "state") return handleCampaignState(request, segments[2], segments[4], ctx);
    if (segments[3] === "sessions") return handleCampaignSessions(request, segments[2], ctx);
    if (segments[3] === "relationships" || segments[3] === "relationship-subjects") {
      return handleCampaignRelationships(request, segments[2], segments[4], segments[5] ?? segments[3], ctx);
    }
    return handleCampaigns(request, segments[2], ctx.db);
  }

  if (resource === "sessions" && typeof segments[2] === "string") {
    const sessionId = segments[2];
    const action = segments[3];
    if (action === "fork" && request.method === "POST") {
      const body = await readObjectBody(request);
      if (body instanceof Response) return body;
      try {
        const source = getSession(ctx.db, sessionId);
        if (!source) return notFound("Unknown session");
        const sourceCampaign = getCampaign(ctx.db, source.campaign_id);
        if (!sourceCampaign) return jsonError(500, "Internal server error");
        if (ctx.play.hasPending(sourceCampaign.active_session_id)) {
          throw new BusyError("A reply is already being generated for this session");
        }
        const forked = forkCampaignFromSession(ctx.db, sessionId, parseForkInput(body));
        return forked ? jsonResponse(forked, 201) : notFound("Unknown session");
      } catch (error) {
        return domainErrorResponse(error) ?? jsonError(500, "Internal server error");
      }
    }
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
      if (request.method === "GET") {
        if (!getSession(ctx.db, sessionId)) return notFound("Unknown session");
        return jsonResponse({ messages: ctx.play.transcript(sessionId) });
      }
      if (request.method === "POST") return handlePlayPost(request, "messages", sessionId, ctx);
      return jsonError(405, "Method not allowed");
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
    store: new CredentialStore(options.configDirectory),
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
