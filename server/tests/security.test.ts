import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { headersWith, makeConfigDirectory, removeDirectory, startTestServer, type TestServer } from "./helpers";
import { SERVER_PORT } from "../runtime";

const TRUSTED_ORIGIN = "http://localhost:5173";
const EVIL_ORIGIN = "http://evil.example";

let server: TestServer;
let configDirectory: string;

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  server = await startTestServer({ configDirectory });
});

afterAll(async () => {
  await server?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

function putProvider(origin: string | null, body = "{}", extraHeaders?: Record<string, string>): Promise<Response> {
  const headers = headersWith({ "content-type": "application/json", ...extraHeaders });
  if (origin !== null) headers.origin = origin;
  return fetch(`${server.url}/api/provider`, { method: "PUT", headers, body });
}

describe("Host header protection (DNS rebinding)", () => {
  test("rejects foreign Host on every route and method", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/provider", undefined],
      ["PUT", "/api/provider", "{}"],
      ["DELETE", "/api/provider", undefined],
      ["POST", "/api/chat", "{}"],
    ] as const) {
      const response = await fetch(`${server.url}${path}`, {
        method,
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json", host: "attacker.example:443" }),
        body,
      });
      expect(response.status).toBe(403);
    }
  });

  test("rejects lookalike hosts; the ephemeral test port itself is untrusted", async () => {
    // No host override: requests carry 127.0.0.1:<ephemeral>, outside the allowlist.
    const defaults = await fetch(`${server.url}/api/provider`);
    expect(defaults.status).toBe(403);
    for (const host of [
      `LOCALHOST.:${SERVER_PORT}`,
      `localhost.evil.com:${SERVER_PORT}`,
      `.localhost:${SERVER_PORT}`,
      `localhost:${SERVER_PORT}:`,
      `localhost:${SERVER_PORT}.`,
    ]) {
      const response = await fetch(`${server.url}/api/provider`, { headers: { host } });
      expect(response.status).toBe(403);
    }
  });

  test("accepts canonical local hosts", async () => {
    for (const host of [`localhost:${SERVER_PORT}`, `127.0.0.1:${SERVER_PORT}`]) {
      const response = await fetch(`${server.url}/api/provider`, { headers: { host } });
      expect(response.status).toBe(200);
    }
  });
});

describe("Origin protection", () => {
  test("mutations without an Origin header are rejected", async () => {
    expect((await putProvider(null)).status).toBe(403);
    const deleted = await fetch(`${server.url}/api/provider`, {
      method: "DELETE",
      headers: headersWith(),
    });
    expect(deleted.status).toBe(403);
    const chat = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: headersWith({ "content-type": "application/json" }),
      body: JSON.stringify({ messages: [] }),
    });
    expect(chat.status).toBe(403);
  });

  test("mutations from untrusted origins are rejected without echoing input", async () => {
    for (const origin of [EVIL_ORIGIN, "null", "https://localhost:5173", "http://localhost:5173.evil.com"]) {
      const response = await putProvider(origin, JSON.stringify({ model: "glm-5.3", api_key: "sk-secret-input" }));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("sk-secret-input");
    }
  });

  test("mutations from every trusted dev/preview/server origin pass the gate", async () => {
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
      `http://localhost:${SERVER_PORT}`,
      `http://127.0.0.1:${SERVER_PORT}`,
    ]) {
      const response = await putProvider(origin, JSON.stringify({ model: "bad model!" }));
      // Past the origin gate, then rejected on validation.
      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  test("GET with an untrusted Origin is rejected; trusted or absent Origin is fine", async () => {
    const evil = await fetch(`${server.url}/api/provider`, { headers: headersWith({ origin: EVIL_ORIGIN }) });
    expect(evil.status).toBe(403);

    const trusted = await fetch(`${server.url}/api/provider`, { headers: headersWith({ origin: TRUSTED_ORIGIN }) });
    expect(trusted.status).toBe(200);
    expect(trusted.headers.get("access-control-allow-origin")).toBe(TRUSTED_ORIGIN);

    const plain = await fetch(`${server.url}/api/provider`, { headers: headersWith() });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("preflight honors the allowlist and never emits wildcards", async () => {
    const evil = await fetch(`${server.url}/api/provider`, {
      method: "OPTIONS",
      headers: headersWith({ origin: EVIL_ORIGIN }),
    });
    expect(evil.status).toBe(403);

    const trusted = await fetch(`${server.url}/api/chat`, {
      method: "OPTIONS",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "access-control-request-method": "POST" }),
    });
    expect(trusted.status).toBe(204);
    expect(trusted.headers.get("access-control-allow-origin")).toBe(TRUSTED_ORIGIN);
    expect(trusted.headers.get("access-control-allow-methods")).toContain("POST");
    expect(trusted.headers.get("access-control-allow-headers")).toContain("content-type");

    const crossRead = await fetch(`${server.url}/api/provider`, { headers: headersWith({ origin: EVIL_ORIGIN }) });
    expect(crossRead.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("Body handling", () => {
  test("rejects non-JSON content types", async () => {
    const form = new FormData();
    form.set("model", "glm-5.3");
    const response = await fetch(`${server.url}/api/provider`, {
      method: "PUT",
      headers: headersWith({ origin: TRUSTED_ORIGIN }),
      body: form,
    });
    expect(response.status).toBe(415);
  });

  test("rejects oversized Content-Length and unlimited chunked bodies", async () => {
    const declared = await fetch(`${server.url}/api/provider`, {
      method: "PUT",
      headers: headersWith({
        origin: TRUSTED_ORIGIN,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ model: "glm-5.3", padding: "x".repeat(200 * 1024) }),
    });
    expect(declared.status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode(JSON.stringify({ model: "glm-5.3", padding: "x".repeat(1024) }));
        for (let i = 0; i < 200; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const chunked = await fetch(`${server.url}/api/provider`, {
      method: "PUT",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  test("rejects invalid JSON, non-object JSON and non-UTF8 payloads", async () => {
    const invalid = await fetch(`${server.url}/api/provider`, {
      method: "PUT",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: "{not json",
    });
    expect(invalid.status).toBe(400);

    const array = await fetch(`${server.url}/api/provider`, {
      method: "PUT",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: "[1,2,3]",
    });
    expect(array.status).toBe(400);

    const binary = await fetch(`${server.url}/api/provider`, {
      method: "PUT",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
    });
    expect(binary.status).toBe(400);
  });
});

describe("Routing", () => {
  test("unknown paths return 404 and wrong methods return 405", async () => {
    expect((await fetch(`${server.url}/api/nope`, { headers: headersWith() })).status).toBe(404);
    expect((await fetch(`${server.url}/`, { headers: headersWith() })).status).toBe(404);
    const patched = await fetch(`${server.url}/api/provider`, {
      method: "PATCH",
      headers: headersWith({ origin: TRUSTED_ORIGIN }),
    });
    expect(patched.status).toBe(405);
    expect((await fetch(`${server.url}/api/chat`, { headers: headersWith() })).status).toBe(405);
    const deletedChat = await fetch(`${server.url}/api/chat`, {
      method: "DELETE",
      headers: headersWith({ origin: TRUSTED_ORIGIN }),
    });
    expect(deletedChat.status).toBe(405);
  });
});

describe("Chat input validation", () => {
  test("rejects malformed message payloads before touching the provider", async () => {
    const cases: unknown[] = [
      {},
      { messages: [] },
      { messages: "hello" },
      { messages: [{ role: "system", content: "hi" }] },
      { messages: [{ role: "user", content: "" }] },
      { messages: [{ role: "user", content: 5 }] },
      { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] },
      { messages: [{ role: "user", content: "x".repeat(100_001) }] },
      { messages: Array.from({ length: 257 }, () => ({ role: "user", content: "hi" })) },
    ];
    for (const body of cases) {
      const response = await fetch(`${server.url}/api/chat`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(typeof payload.error).toBe("string");
    }
  });

  test("chat without a configured key fails safely before contacting upstream", async () => {
    const response = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(400);
  });
});
