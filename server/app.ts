import { CredentialStore, publicConfig, validateApiKey, validateModel } from "./config";
import { streamZaiChat, validateChatMessages } from "./chat";
import {
  BODY_LIMITS,
  hasTrustedOrigin,
  isJsonContentType,
  isTrustedHost,
  jsonError,
  jsonResponse,
  preflightResponse,
  readJsonBody,
  trustedOrigin,
  withCors,
} from "./security";

export interface CreateAppOptions {
  /** Overrides the credential directory (isolated tests). */
  configDirectory?: string;
  /** Injection point for the Z.AI upstream call (tests only). */
  upstreamFetch?: typeof fetch;
}

export type AppFetchHandler = (request: Request) => Promise<Response>;

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
  if (typeof body.value !== "object" || body.value === null) {
    return jsonError(400, "Body must be a JSON object");
  }

  const { model, api_key } = body.value as Record<string, unknown>;
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

async function handleChatPost(
  request: Request,
  store: CredentialStore,
  upstreamFetch: typeof fetch | undefined,
): Promise<Response> {
  if (!isJsonContentType(request)) {
    return jsonError(415, "Content-Type must be application/json");
  }
  const body = await readJsonBody(request, BODY_LIMITS.chat);
  if (!body.ok) return body.response;

  const messages = validateChatMessages(body.value);
  if (!messages.ok) return jsonError(400, messages.error);

  const requestedModel = (body.value as Record<string, unknown>).model;
  if (requestedModel !== undefined) {
    const modelError = validateModel(requestedModel);
    if (modelError) return jsonError(400, modelError);
  }

  const settings = await store.load();
  if (settings === null) {
    return jsonError(400, "No provider API key configured");
  }

  return streamZaiChat({
    model: typeof requestedModel === "string" ? requestedModel : settings.model,
    apiKey: settings.api_key,
    messages: messages.messages,
    disconnectSignal: request.signal,
    ...(upstreamFetch ? { upstreamFetch } : {}),
  });
}

/**
 * Builds the Storyfold local API as a standalone fetch handler suitable for
 * `Bun.serve({ fetch })`. Secrets never appear in any
 * response body, error message or log line.
 */
export function createApp(options: CreateAppOptions = {}): AppFetchHandler {
  const store = new CredentialStore(options.configDirectory);

  return async (request: Request): Promise<Response> => {
    let response: Response;
    try {
      if (!isTrustedHost(request)) {
        response = jsonError(403, "Untrusted host");
      } else if (request.method === "OPTIONS") {
        response = preflightResponse(request);
      } else {
        const { pathname } = new URL(request.url);

        if (pathname === "/api/provider") {
          if (request.method === "GET") {
            response = await handleProviderGet(request, store);
          } else if (request.method === "PUT") {
            response = hasTrustedOrigin(request)
              ? await handleProviderPut(request, store)
              : jsonError(403, "Origin not allowed");
          } else if (request.method === "DELETE") {
            response = hasTrustedOrigin(request)
              ? await handleProviderDelete(request, store)
              : jsonError(403, "Origin not allowed");
          } else {
            response = jsonError(405, "Method not allowed");
          }
        } else if (pathname === "/api/chat") {
          if (request.method === "POST") {
            response = hasTrustedOrigin(request)
              ? await handleChatPost(request, store, options.upstreamFetch)
              : jsonError(403, "Origin not allowed");
          } else {
            response = jsonError(405, "Method not allowed");
          }
        } else {
          response = jsonError(404, "Not found");
        }
      }
    } catch {
      response = jsonError(500, "Internal server error");
    }
    return withCors(response, request);
  };
}
