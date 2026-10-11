import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialStore, ZAI_BASE_URL } from "../config";
import type { ProviderSettings } from "../config";
import { headersWith, makeConfigDirectory, removeDirectory, startTestServer } from "./helpers";

const API_KEY = "sk-zai-test-key-1234567890";

describe("CredentialStore", () => {
  test("save creates dir 0700 and file 0600, load round-trips", async () => {
    const dir = await makeConfigDirectory();
    try {
      const store = new CredentialStore(dir);
      const settings = await store.save({ model: "glm-5.4", api_key: API_KEY });
      expect(settings.model).toBe("glm-5.4");
      expect(settings.api_key).toBe(API_KEY);
      expect(settings.base_url).toBe(ZAI_BASE_URL);

      const dirStat = await stat(dir);
      expect(dirStat.mode & 0o777).toBe(0o700);
      const fileStat = await stat(join(dir, "config.json"));
      expect(fileStat.mode & 0o777).toBe(0o600);

      const loaded = await store.load();
      expect(loaded?.model).toBe("glm-5.4");
      expect(loaded?.api_key).toBe(API_KEY);
    } finally {
      await removeDirectory(dir);
    }
  });

  test("save without api_key preserves existing key and rejects on empty store", async () => {
    const dir = await makeConfigDirectory();
    try {
      const store = new CredentialStore(dir);
      await store.save({ model: "glm-5.3", api_key: API_KEY });
      await store.save({ model: "glm-5.4" });
      const loaded = await store.load();
      expect(loaded?.model).toBe("glm-5.4");
      expect(loaded?.api_key).toBe(API_KEY);

      const fresh = new CredentialStore(await makeConfigDirectory());
      try {
        await expect(fresh.save({ model: "glm-5.3" })).rejects.toThrow();
      } finally {
        await removeDirectory(fresh.configDirectory);
      }
    } finally {
      await removeDirectory(dir);
    }
  });

  test("remove is idempotent and load treats missing or corrupt config as unconfigured", async () => {
    const dir = await makeConfigDirectory();
    try {
      const store = new CredentialStore(dir);
      await store.save({ model: "glm-5.3", api_key: API_KEY });
      await store.remove();
      expect(await store.load()).toBeNull();
      await store.remove();

      await writeFile(join(dir, "config.json"), "{ not json !!!");
      expect(await store.load()).toBeNull();

      await writeFile(join(dir, "config.json"), JSON.stringify({ model: "x", api_key: "" }));
      expect(await store.load()).toBeNull();

      await writeFile(join(dir, "config.json"), JSON.stringify({ model: "bad model!", api_key: "k" }));
      expect(await store.load()).toBeNull();
    } finally {
      await removeDirectory(dir);
    }
  });

  // Regression: a model-only save reads the stored key before writing. When it
  // overlaps a concurrent mutation on the same shared store instance, the stale
  // key used to win on disk after the other mutation had already resolved.
  test("overlapping model-only save cannot undo a completed key rotation", async () => {
    const dir = await makeConfigDirectory();
    try {
      const NEW_KEY = "sk-zai-test-key-0987654321";
      const store = new GatedCredentialStore(dir);
      await store.save({ model: "glm-5.3", api_key: API_KEY });

      store.gated = true;
      const staleSave = store.save({ model: "glm-5.4" });
      await store.gateReached.promise;

      const rotation = store.save({ model: "glm-5.3", api_key: NEW_KEY });
      if (await store.newestMutationPending()) {
        // Serialized: the parked save holds the lock and the queue applies the
        // rotation after the stale write lands.
        store.release();
      } else {
        // Serialization broken: hold the stale write until the rotation has
        // landed so the stale key would deterministically win on disk.
        await store.competingSettled.promise;
        store.release();
      }
      await Promise.all([staleSave, rotation]);

      expect((await store.load())?.api_key).toBe(NEW_KEY);
    } finally {
      await removeDirectory(dir);
    }
  });

  test("overlapping model-only save cannot resurrect a removed key", async () => {
    const dir = await makeConfigDirectory();
    try {
      const store = new GatedCredentialStore(dir);
      await store.save({ model: "glm-5.3", api_key: API_KEY });

      store.gated = true;
      const staleSave = store.save({ model: "glm-5.4" });
      await store.gateReached.promise;

      const removal = store.remove();
      if (await store.newestMutationPending()) {
        store.release();
      } else {
        await store.competingSettled.promise;
        store.release();
      }
      await Promise.all([staleSave, removal]);

      expect(await store.load()).toBeNull();
    } finally {
      await removeDirectory(dir);
    }
  });
});

// Parks load() after reading the stored key, freezing a model-only save inside
// the window where it holds a stale credential, and reports when a competing
// explicit-key mutation has landed. Keeps the overlap tests free of timing
// assumptions in both the serialized and the broken-serialization worlds.
class GatedCredentialStore extends CredentialStore {
  gated = false;
  readonly gateReached = Promise.withResolvers<void>();
  readonly competingSettled = Promise.withResolvers<void>();
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  async load(): Promise<ProviderSettings | null> {
    const settings = await super.load();
    if (this.gated) {
      this.gateReached.resolve();
      this.gate ??= new Promise<void>((resolve) => {
        this.openGate = resolve;
      });
      await this.gate;
    }
    return settings;
  }

  save(input: { model: string; api_key?: string }): Promise<ProviderSettings> {
    const result = super.save(input);
    // Only a mutation started while the gate is parked competes with the
    // parked save; the seed save (gated=false) must not resolve the signal.
    if (this.gated && input.api_key !== undefined) this.signalCompeting(result);
    return result;
  }

  remove(): Promise<void> {
    const result = super.remove();
    if (this.gated) this.signalCompeting(result);
    return result;
  }

  /** Opens the gate, letting the parked save proceed. */
  release(): void {
    this.gated = false;
    this.openGate?.();
  }

  /**
   * True while the newest mutation is still serialized behind the parked save.
   * When serialization is broken, the queue is drained or gone and the caller
   * must hold release() until the mutation has actually landed on disk.
   */
  async newestMutationPending(): Promise<boolean> {
    let settled = false;
    void this.queue.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    return !settled;
  }

  private signalCompeting(result: Promise<unknown>): void {
    const settle = () => this.competingSettled.resolve();
    void result.then(settle, settle);
  }
}

describe("Provider settings API", () => {
  test("full key lifecycle over HTTP, surviving an app restart", async () => {
    const dir = await makeConfigDirectory();
    let server = await startTestServer({ configDirectory: dir });
    try {
      const headers = headersWith({ origin: "http://localhost:5173", "content-type": "application/json" });

      // Unconfigured
      let response = await fetch(`${server.url}/api/provider`, { headers: headersWith() });
      expect(response.status).toBe(200);
      expect(((await response.json()) as Record<string, unknown>).has_api_key).toBe(false);

      // New configuration requires a key
      const noKey = await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ model: "glm-5.3" }),
      });
      expect(noKey.status).toBe(400);

      // Configure
      const created = await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ model: "glm-5.3", api_key: API_KEY }),
      });
      expect(created.status).toBe(200);
      expect(((await created.json()) as Record<string, unknown>).has_api_key).toBe(true);

      // Model-only edit preserves the key
      const edited = await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ model: "glm-5.4" }),
      });
      expect(edited.status).toBe(200);
      expect(((await edited.json()) as Record<string, unknown>).model).toBe("glm-5.4");
      const onDisk = await readFile(join(dir, "config.json"), "utf8");
      expect(onDisk).toContain(API_KEY);

      // Restart: a fresh app instance over the same directory keeps state
      await server.stop();
      server = await startTestServer({ configDirectory: dir });
      const afterRestart = await fetch(`${server.url}/api/provider`, { headers: headersWith() });
      const restartBody = (await afterRestart.json()) as Record<string, unknown>;
      expect(restartBody.has_api_key).toBe(true);
      expect(restartBody.model).toBe("glm-5.4");
      expect(JSON.stringify(restartBody)).not.toContain(API_KEY);

      // Removal restores defaults
      const removed = await fetch(`${server.url}/api/provider`, { method: "DELETE", headers });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as Record<string, unknown>).has_api_key).toBe(false);
      expect(await statSafe(join(dir, "config.json"))).toBeNull();
      expect((await fetch(`${server.url}/api/provider`, { method: "DELETE", headers })).status).toBe(200);
    } finally {
      await server.stop();
      await removeDirectory(dir);
    }
  });

  test("rejects invalid model and blank key", async () => {
    const dir = await makeConfigDirectory();
    const server = await startTestServer({ configDirectory: dir });
    try {
      const headers = headersWith({ origin: "http://localhost:5173", "content-type": "application/json" });
      const badModel = await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ model: "not a model!", api_key: API_KEY }),
      });
      expect(badModel.status).toBe(400);

      const blankKey = await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ model: "glm-5.3", api_key: "   " }),
      });
      expect(blankKey.status).toBe(400);

      const missingModel = await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ api_key: API_KEY }),
      });
      expect(missingModel.status).toBe(400);
    } finally {
      await server.stop();
      await removeDirectory(dir);
    }
  });

  test("responses and errors never contain the key", async () => {
    const dir = await makeConfigDirectory();
    const server = await startTestServer({ configDirectory: dir });
    try {
      const headers = headersWith({ origin: "http://localhost:5173", "content-type": "application/json" });
      await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ model: "glm-5.3", api_key: API_KEY }),
      });
      for (const path of ["/api/provider", "/nope"]) {
        const response = await fetch(`${server.url}${path}`, { headers: headersWith() });
        expect(await response.text()).not.toContain(API_KEY);
      }
      const forbidden = await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers: headersWith({ ...headers, origin: "http://evil.example" }),
        body: JSON.stringify({ model: "x" }),
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.text()).not.toContain(API_KEY);
    } finally {
      await server.stop();
      await removeDirectory(dir);
    }
  });
});

async function statSafe(path: string): Promise<unknown> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
