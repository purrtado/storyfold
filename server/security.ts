import { SERVER_PORT } from "./runtime";

const SERVER_HOSTS: Record<string, true> = {
  [`localhost:${SERVER_PORT}`]: true,
  [`127.0.0.1:${SERVER_PORT}`]: true,
};

const TRUSTED_ORIGINS: Record<string, true> = {
  [`http://localhost:${SERVER_PORT}`]: true,
  [`http://127.0.0.1:${SERVER_PORT}`]: true,
  "http://localhost:5173": true,
  "http://127.0.0.1:5173": true,
  "http://localhost:4173": true,
  "http://127.0.0.1:4173": true,
};

const JSON_BODY_MAX_BYTES = 64 * 1024;
const CHAT_BODY_MAX_BYTES = 1024 * 1024;

const NO_STORE_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

/** Rejects Host headers outside the local allowlist (DNS rebinding defense). */
export function isTrustedHost(request: Request): boolean {
  const host = request.headers.get("host");
  if (host === null) return false;
  return SERVER_HOSTS[host.toLowerCase()] === true;
}

/** Returns the request's Origin header when explicitly allowlisted, else null. */
export function trustedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  return TRUSTED_ORIGINS[origin.toLowerCase()] === true ? origin : null;
}

/** Mutations (PUT/DELETE/POST) must carry an allowlisted Origin header. */
export function hasTrustedOrigin(request: Request): boolean {
  return request.headers.get("origin") !== null && trustedOrigin(request) !== null;
}

export function jsonError(status: number, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...NO_STORE_HEADERS, ...extraHeaders },
  });
}

export function jsonResponse(value: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...NO_STORE_HEADERS, ...extraHeaders },
  });
}

function corsHeadersFor(request: Request): Record<string, string> {
  const origin = trustedOrigin(request);
  return origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
}

/** Preflight only for allowlisted origins; never permissive. */
export function preflightResponse(request: Request): Response {
  const origin = trustedOrigin(request);
  if (!origin) return jsonError(403, "Origin not allowed");
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, PUT, DELETE, POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    },
  });
}

export function withCors(response: Response, request: Request): Response {
  const cors = corsHeadersFor(request);
  if (Object.keys(cors).length === 0) return response;
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  return response;
}

export function isJsonContentType(request: Request): boolean {
  const type = request.headers.get("content-type");
  return type !== null && type.toLowerCase().startsWith("application/json");
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

/**
 * Reads a JSON body with a hard byte cap, covering both a lying/misleading
 * Content-Length header and unlimited chunked transfers.
 */
export async function readJsonBody(request: Request, limitBytes: number): Promise<JsonBodyResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isInteger(declared) || declared < 0) {
      return { ok: false, response: jsonError(400, "Invalid Content-Length header") };
    }
    if (declared > limitBytes) {
      return { ok: false, response: jsonError(413, "Request body too large") };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, response: jsonError(400, "Request body required") };
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, response: jsonError(413, "Request body too large") };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    return { ok: false, response: jsonError(400, "Request body must be UTF-8 JSON") };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: jsonError(400, "Invalid JSON body") };
  }
}

export const BODY_LIMITS = { provider: JSON_BODY_MAX_BYTES, chat: CHAT_BODY_MAX_BYTES };
