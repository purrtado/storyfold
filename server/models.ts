import { MODEL_LIST_MAX, isValidModel, type StoredProvider } from "./providers";

/** A listing younger than this is served as-is; older ones are served while a refresh runs. */
const FRESH_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface ModelEntry {
  id: string;
  enabled: boolean;
  manual: boolean;
}

export interface ModelListing {
  models: ModelEntry[];
  fetched_at: string | null;
  /** Why the provider's own list is missing or stale; manual models are still listed. */
  error: string | null;
}

interface CachedList {
  ids: string[];
  fetchedAt: number;
}

class ModelFetchError extends Error {}

/** Fixed messages only: upstream bodies, URLs and keys never reach the client. */
async function fetchRemoteModels(provider: StoredProvider, upstreamFetch: typeof fetch): Promise<string[]> {
  let response: Response;
  try {
    response = await upstreamFetch(`${provider.base_url}/models`, {
      headers: {
        accept: "application/json",
        ...(provider.api_key !== null ? { authorization: `Bearer ${provider.api_key}` } : {}),
      },
      // A redirect could carry the Authorization header to another host.
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ModelFetchError(
      error instanceof DOMException && error.name === "TimeoutError"
        ? "The provider did not respond in time."
        : "Could not reach the provider.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ModelFetchError(`The provider rejected the API key (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new ModelFetchError(`The provider could not list models (HTTP ${response.status}).`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const data = typeof body === "object" && body !== null && "data" in body ? body.data : undefined;
  if (!Array.isArray(data)) throw new ModelFetchError("The provider's model list is not in OpenAI format.");
  const ids = new Set<string>();
  for (const item of data) {
    const id: unknown = typeof item === "object" && item !== null && "id" in item ? item.id : undefined;
    if (isValidModel(id)) ids.add(id);
    if (ids.size >= MODEL_LIST_MAX) break;
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Per-provider /models cache, stale-while-revalidate. Entries are dropped when
 * a provider's base URL or key changes; an in-flight fetch started under the
 * old credentials is then discarded instead of repopulating the cache.
 */
export class ModelCatalog {
  private readonly cache = new Map<string, CachedList>();
  private readonly inflight = new Map<string, Promise<CachedList>>();

  constructor(
    private readonly upstreamFetch: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(providerId: string): void {
    this.cache.delete(providerId);
    this.inflight.delete(providerId);
  }

  private refresh(provider: StoredProvider): Promise<CachedList> {
    const running = this.inflight.get(provider.id);
    if (running) return running;
    const request = fetchRemoteModels(provider, this.upstreamFetch).then(
      (ids) => {
        const entry = { ids, fetchedAt: this.now() };
        if (this.inflight.get(provider.id) === request) this.cache.set(provider.id, entry);
        return entry;
      },
    );
    this.inflight.set(provider.id, request);
    const clear = () => {
      if (this.inflight.get(provider.id) === request) this.inflight.delete(provider.id);
    };
    request.then(clear, clear);
    return request;
  }

  async list(provider: StoredProvider, options: { refresh?: boolean } = {}): Promise<ModelListing> {
    let entry = this.cache.get(provider.id);
    let error: string | null = null;
    if (entry === undefined || options.refresh) {
      try {
        entry = await this.refresh(provider);
      } catch (cause) {
        error = cause instanceof ModelFetchError ? cause.message : "Could not list models.";
      }
    } else if (this.now() - entry.fetchedAt >= FRESH_MS) {
      this.refresh(provider).catch(() => {});
    }

    // Manual ids always appear; remote ids fill the rest of the cap, so a
    // "disable all" of the listing always fits in disabled_models.
    const manual = new Set(provider.manual_models);
    const remote = (entry?.ids ?? []).filter((id) => !manual.has(id)).slice(0, MODEL_LIST_MAX - manual.size);
    const ids = [...remote, ...provider.manual_models].sort((a, b) => a.localeCompare(b));
    const disabled = new Set(provider.disabled_models);
    return {
      models: ids.map((id) => ({ id, enabled: !disabled.has(id), manual: manual.has(id) })),
      fetched_at: entry ? new Date(entry.fetchedAt).toISOString() : null,
      error,
    };
  }
}
