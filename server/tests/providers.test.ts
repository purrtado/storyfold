import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelCatalog } from "../models";
import { ProviderStore, type ProviderConfig, type StoredProvider } from "../providers";
import { headersWith, makeConfigDirectory, removeDirectory, startTestServer } from "./helpers";

const API_KEY = "sk-provider-test-key-1234567890";
const BASE_URL = "https://api.example.test/v1";
const TRUSTED = { origin: "http://localhost:5173", "content-type": "application/json" };

async function withStore<T>(run: (store: ProviderStore, dir: string) => Promise<T>): Promise<T> {
  const dir = await makeConfigDirectory();
  try {
    return await run(new ProviderStore(dir), dir);
  } finally {
    await removeDirectory(dir);
  }
}

function createInput(overrides: Partial<StoredProvider> = {}) {
  return { name: "Example", base_url: BASE_URL, api_key: API_KEY, manual_models: [], ...overrides };
}

describe("ProviderStore", () => {
  test("writes dir 0700 and file 0600 and round-trips providers", async () => {
    await withStore(async (store, dir) => {
      const created = await store.create(createInput());
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, "config.json"))).mode & 0o777).toBe(0o600);
      expect(await store.get(created.id)).toEqual(created);
    });
  });

  test("migrates the legacy single Z.AI document with its key, catalog and selection", async () => {
    await withStore(async (store, dir) => {
      await writeFile(
        join(dir, "config.json"),
        JSON.stringify({
          base_url: "https://api.z.ai/api/coding/paas/v4",
          model: "glm-5.4",
          api_key: API_KEY,
          updated_at: "2026-01-01T00:00:00.000Z",
        }),
      );
      const config = await store.load();
      expect(config.providers).toHaveLength(1);
      expect(config.providers[0]).toMatchObject({
        id: "zai",
        base_url: "https://api.z.ai/api/coding/paas/v4",
        api_key: API_KEY,
        disabled_models: [],
        manual_models: ["glm-5.3", "glm-5.3-flash", "glm-5.4"],
      });
      expect(config.selection).toEqual({ provider_id: "zai", model: "glm-5.4" });

      // The migrated id is stable, so a later write persists the same provider.
      await store.update("zai", { name: "Z.AI" });
      expect(JSON.parse(await readFile(join(dir, "config.json"), "utf8")).providers[0].id).toBe("zai");
    });
  });

  test("a base_url-only edit keeps the stored key and still invalidates the model list", async () => {
    await withStore(async (store) => {
      const { id } = await store.create(createInput());

      const renamed = await store.update(id, { name: "Renamed", base_url: BASE_URL });
      expect(renamed.provider.api_key).toBe(API_KEY);
      expect(renamed.credentialsChanged).toBe(false);

      const moved = await store.update(id, { base_url: "https://elsewhere.test/v1" });
      expect(moved.provider.api_key).toBe(API_KEY);
      expect(moved.credentialsChanged).toBe(true);

      const removed = await store.update(id, { api_key: null });
      expect(removed.provider.api_key).toBeNull();
    });
  });

  test("corrupt files load empty; malformed entries and dangling selections are dropped", async () => {
    await withStore(async (store, dir) => {
      await writeFile(join(dir, "config.json"), "{ not json !!!");
      expect(await store.load()).toEqual({ providers: [], selection: null });

      const valid = { id: "ok", ...createInput(), disabled_models: [], updated_at: "2026-01-01T00:00:00.000Z" };
      const document: Record<string, unknown> = {
        providers: [valid, { ...valid, id: "bad", base_url: "ftp://nope" }],
        selection: { provider_id: "bad", model: "m" },
      };
      await writeFile(join(dir, "config.json"), JSON.stringify(document));
      const loaded = await store.load();
      expect(loaded.providers.map((provider) => provider.id)).toEqual(["ok"]);
      expect(loaded.selection).toBeNull();
    });
  });

  test("removing the selected provider clears the selection", async () => {
    await withStore(async (store) => {
      const kept = await store.create(createInput());
      const doomed = await store.create(createInput({ name: "Doomed" }));
      await store.setSelection({ provider_id: doomed.id, model: "m" });
      await store.remove(doomed.id);
      expect(await store.load()).toEqual({ providers: [kept], selection: null });
    });
  });

  // Regression: a partial update reads the stored key before writing. When it
  // overlaps a concurrent mutation on the shared store instance, the stale key
  // must not win on disk after the other mutation has resolved.
  test("an overlapping partial update cannot undo a completed key rotation", async () => {
    const dir = await makeConfigDirectory();
    try {
      const store = new GatedProviderStore(dir);
      const { id } = await store.create(createInput());

      store.gated = true;
      const stale = store.update(id, { disabled_models: ["m"] });
      await store.gateReached.promise;
      const rotation = store.update(id, { api_key: "sk-rotated" });
      await store.releaseAfter(rotation);
      await Promise.all([stale, rotation]);

      expect((await store.get(id))?.api_key).toBe("sk-rotated");
    } finally {
      await removeDirectory(dir);
    }
  });

  test("an overlapping partial update cannot resurrect a removed provider", async () => {
    const dir = await makeConfigDirectory();
    try {
      const store = new GatedProviderStore(dir);
      const { id } = await store.create(createInput());

      store.gated = true;
      const stale = store.update(id, { disabled_models: ["m"] }).catch((error: unknown) => error);
      await store.gateReached.promise;
      const removal = store.remove(id);
      await store.releaseAfter(removal);
      await Promise.all([stale, removal]);

      expect((await store.load()).providers).toEqual([]);
    } finally {
      await removeDirectory(dir);
    }
  });
});

/**
 * Parks load() inside the first gated mutation, freezing it while it holds a
 * stale snapshot. releaseAfter() then lets it go either immediately (the
 * competing mutation is queued behind it, as it must be) or only once the
 * competitor has landed (serialization broken: the stale write deterministically
 * wins), keeping both worlds free of timing assumptions.
 */
class GatedProviderStore extends ProviderStore {
  gated = false;
  readonly gateReached = Promise.withResolvers<void>();
  private readonly gate = Promise.withResolvers<void>();

  async load(): Promise<ProviderConfig> {
    const config = await super.load();
    if (this.gated) {
      this.gated = false;
      this.gateReached.resolve();
      await this.gate.promise;
    }
    return config;
  }

  async releaseAfter(competing: Promise<unknown>): Promise<void> {
    let settled = false;
    const settle = () => {
      settled = true;
    };
    void this.queue.then(settle, settle);
    await Promise.resolve();
    await Promise.resolve();
    if (settled) await competing.catch(() => {});
    this.gate.resolve();
  }
}

describe("ModelCatalog", () => {
  const provider: StoredProvider = {
    id: "p",
    ...createInput(),
    disabled_models: ["b"],
    manual_models: ["manual-1"],
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  function upstream(responses: Array<() => Response>) {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return responses[Math.min(calls.length - 1, responses.length - 1)]();
    }) as typeof fetch;
    return { calls, fetcher };
  }

  const ok = (ids: string[]) => () => Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

  test("merges manual ids, applies sticky disables, and serves stale lists while refreshing", async () => {
    let now = 0;
    const { calls, fetcher } = upstream([ok(["b", "a"]), ok(["a", "b", "c"])]);
    const catalog = new ModelCatalog(fetcher, () => now);

    const first = await catalog.list(provider);
    expect(calls[0]).toEqual({ url: `${BASE_URL}/models`, authorization: `Bearer ${API_KEY}` });
    expect(first.models).toEqual([
      { id: "a", enabled: true, manual: false },
      { id: "b", enabled: false, manual: false },
      { id: "manual-1", enabled: true, manual: true },
    ]);

    now = 30 * 60 * 1000;
    await catalog.list(provider);
    expect(calls).toHaveLength(1);

    // Past the freshness window the cached list answers at once while a
    // background refetch runs; newly listed models arrive enabled.
    now = 61 * 60 * 1000;
    const stale = await catalog.list(provider);
    expect(stale.models.map((model) => model.id)).toEqual(["a", "b", "manual-1"]);
    expect(calls).toHaveLength(2);
    // refresh joins the in-flight background fetch instead of starting another.
    const refreshed = await catalog.list(provider, { refresh: true });
    expect(calls).toHaveLength(2);
    expect(refreshed.models.find((model) => model.id === "c")).toEqual({ id: "c", enabled: true, manual: false });
    expect(refreshed.models.find((model) => model.id === "b")?.enabled).toBe(false);
  });

  test("failures keep manual and last-known models and never echo upstream detail", async () => {
    const { fetcher } = upstream([
      ok(["a"]),
      () => new Response(`{"error":"bad key ${API_KEY}"}`, { status: 401 }),
    ]);
    const catalog = new ModelCatalog(fetcher);
    await catalog.list(provider);
    const failed = await catalog.list(provider, { refresh: true });
    expect(failed.error).toBe("The provider rejected the API key (HTTP 401).");
    expect(failed.models.map((model) => model.id)).toEqual(["a", "manual-1"]);
    expect(failed.fetched_at).not.toBeNull();

    const cold = new ModelCatalog(upstream([() => new Response("nope", { status: 500 })]).fetcher);
    const coldResult = await cold.list(provider);
    expect(coldResult.models.map((model) => model.id)).toEqual(["manual-1"]);
    expect(coldResult.fetched_at).toBeNull();
    expect(JSON.stringify(coldResult)).not.toContain(API_KEY);
  });

  test("a fetch started before invalidation does not repopulate the cache", async () => {
    const pending = Promise.withResolvers<Response>();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return calls === 1 ? pending.promise : ok(["fresh"])();
    }) as unknown as typeof fetch;
    const catalog = new ModelCatalog(fetcher);

    const old = catalog.list(provider);
    catalog.invalidate(provider.id);
    pending.resolve(ok(["old"])());
    await old;
    const next = await catalog.list(provider);
    expect(next.models.map((model) => model.id)).toEqual(["fresh", "manual-1"]);
  });
});

describe("Providers API", () => {
  test("provider lifecycle and selection over HTTP survive a restart; keys never leave the server", async () => {
    const dir = await makeConfigDirectory();
    let server = await startTestServer({ configDirectory: dir });
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: headersWith(TRUSTED),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    try {
      expect(await (await call("GET", "/api/providers")).json()).toEqual({ providers: [], selection: null });

      const created = await call("POST", "/api/providers", { name: "Example", base_url: `${BASE_URL}/`, api_key: API_KEY });
      expect(created.status).toBe(201);
      const { provider } = (await created.json()) as { provider: Record<string, unknown> };
      expect(provider).toMatchObject({ name: "Example", base_url: BASE_URL, has_api_key: true });
      expect(provider).not.toHaveProperty("api_key");

      const keyless = await call("POST", "/api/providers", { name: "Local", base_url: "http://localhost:11434/v1" });
      expect(((await keyless.json()) as { provider: { has_api_key: boolean } }).provider.has_api_key).toBe(false);

      expect((await call("PUT", "/api/model-selection", { provider_id: provider.id, model: "openai/gpt-5" })).status).toBe(200);
      const patched = await call("PATCH", `/api/providers/${provider.id}`, { disabled_models: ["x", "x"] });
      expect(((await patched.json()) as { provider: { disabled_models: string[] } }).provider.disabled_models).toEqual(["x"]);

      await server.stop();
      server = await startTestServer({ configDirectory: dir });
      const listed = await call("GET", "/api/providers");
      const text = await listed.text();
      expect(text).not.toContain(API_KEY);
      const body = JSON.parse(text) as { providers: Array<{ id: string }>; selection: unknown };
      expect(body.providers).toHaveLength(2);
      expect(body.selection).toEqual({ provider_id: provider.id, model: "openai/gpt-5" });

      expect((await call("DELETE", `/api/providers/${provider.id}`)).status).toBe(200);
      expect((await call("DELETE", `/api/providers/${provider.id}`)).status).toBe(404);
      expect(((await (await call("GET", "/api/providers")).json()) as { selection: unknown }).selection).toBeNull();
    } finally {
      await server.stop();
      await removeDirectory(dir);
    }
  });

  test("every model a provider can list can be disabled in one save", async () => {
    const dir = await makeConfigDirectory();
    const ids = Array.from({ length: 6000 }, (_, index) => `vendor/model-${index}`);
    const upstreamFetch = (async () => Response.json({ data: ids.map((id) => ({ id })) })) as unknown as typeof fetch;
    const server = await startTestServer({ configDirectory: dir, upstreamFetch });
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: headersWith(TRUSTED),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    try {
      const created = await call("POST", "/api/providers", {
        name: "Huge",
        base_url: BASE_URL,
        manual_models: ["hand/added-1", "hand/added-2"],
      });
      const { provider } = (await created.json()) as { provider: { id: string } };
      const listing = (await (await call("GET", `/api/providers/${provider.id}/models`)).json()) as {
        models: Array<{ id: string }>;
      };
      expect(listing.models.map((model) => model.id)).toContain("hand/added-2");
      const disabled = await call("PATCH", `/api/providers/${provider.id}`, {
        disabled_models: listing.models.map((model) => model.id),
      });
      expect(disabled.status).toBe(200);
    } finally {
      await server.stop();
      await removeDirectory(dir);
    }
  });

  test("rejects invalid input and untrusted or missing origins", async () => {
    const dir = await makeConfigDirectory();
    const server = await startTestServer({ configDirectory: dir });
    const post = (body: unknown, headers = headersWith(TRUSTED)) =>
      fetch(`${server.url}/api/providers`, { method: "POST", headers, body: JSON.stringify(body) });
    try {
      for (const base_url of ["ftp://host/v1", "https://user:pw@host/v1", "https://host/v1?x=1", "not a url"]) {
        expect((await post({ name: "Bad", base_url })).status).toBe(400);
      }
      expect((await post({ name: " ", base_url: BASE_URL })).status).toBe(400);
      expect((await post({ name: "Blank key", base_url: BASE_URL, api_key: "  " })).status).toBe(400);
      expect((await post({ name: "Evil", base_url: BASE_URL }, headersWith({ ...TRUSTED, origin: "http://evil.example" }))).status).toBe(403);

      const selection = (body: unknown, headers = headersWith(TRUSTED)) =>
        fetch(`${server.url}/api/model-selection`, { method: "PUT", headers, body: JSON.stringify(body) });
      expect((await selection({ provider_id: "missing", model: "m" })).status).toBe(404);
      expect((await selection({ provider_id: "missing", model: "bad model!" })).status).toBe(400);
      expect((await selection({ provider_id: "missing", model: "m" }, headersWith({ "content-type": "application/json" }))).status).toBe(403);
    } finally {
      await server.stop();
      await removeDirectory(dir);
    }
  });

  test("model listing proxies /models with the stored key and refetches after a key change", async () => {
    const dir = await makeConfigDirectory();
    const authorizations: Array<string | null> = [];
    const upstreamFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ data: [{ id: "gpt-5" }, { id: "not valid!" }] });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory: dir, upstreamFetch });
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: headersWith(TRUSTED),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    try {
      const created = await call("POST", "/api/providers", { name: "Example", base_url: BASE_URL, api_key: API_KEY });
      const { provider } = (await created.json()) as { provider: { id: string } };

      const listing = await (await call("GET", `/api/providers/${provider.id}/models`)).json();
      expect(listing).toMatchObject({ models: [{ id: "gpt-5", enabled: true, manual: false }], error: null });
      await call("GET", `/api/providers/${provider.id}/models`);
      expect(authorizations).toEqual([`Bearer ${API_KEY}`]);

      await call("PATCH", `/api/providers/${provider.id}`, { api_key: "sk-second" });
      await call("GET", `/api/providers/${provider.id}/models`);
      await call("GET", `/api/providers/${provider.id}/models?refresh=1`);
      expect(authorizations).toEqual([`Bearer ${API_KEY}`, "Bearer sk-second", "Bearer sk-second"]);

      expect((await call("GET", "/api/providers/missing/models")).status).toBe(404);
    } finally {
      await server.stop();
      await removeDirectory(dir);
    }
  });
});
