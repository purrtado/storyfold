import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfigDirectory } from "./config";
import { ValidationError } from "./library";

const CONFIG_FILE = "config.json";
const MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const API_KEY_MAX_LENGTH = 512;
const NAME_MAX_LENGTH = 64;
const BASE_URL_MAX_LENGTH = 2048;
/** Caps every model-id list: stored opt-outs, manual ids, and a provider's /models response. */
export const MODEL_LIST_MAX = 5000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Single-provider installs predating the provider list stored this endpoint and catalog. */
const LEGACY_PROVIDER_ID = "zai";
const LEGACY_PROVIDER_NAME = "Z.AI Coding Plan";
const LEGACY_MODELS = ["glm-5.3", "glm-5.3-flash"];

export interface StoredProvider {
  id: string;
  name: string;
  base_url: string;
  api_key: string | null;
  /** Sticky opt-outs: models the provider lists later stay enabled unless named here. */
  disabled_models: string[];
  /** Hand-added ids for providers whose /models is missing or incomplete. */
  manual_models: string[];
  updated_at: string;
}

export interface ModelSelection {
  provider_id: string;
  model: string;
}

export interface ProviderConfig {
  providers: StoredProvider[];
  selection: ModelSelection | null;
}

export interface PublicProvider {
  id: string;
  name: string;
  base_url: string;
  has_api_key: boolean;
  disabled_models: string[];
  manual_models: string[];
  updated_at: string;
}

export interface ProviderCreate {
  name: string;
  base_url: string;
  api_key: string | null;
  manual_models: string[];
}

export interface ProviderPatch {
  name?: string;
  base_url?: string;
  /** null removes the stored key; undefined keeps it. */
  api_key?: string | null;
  disabled_models?: string[];
  manual_models?: string[];
}

export function publicProvider(provider: StoredProvider): PublicProvider {
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    has_api_key: provider.api_key !== null,
    disabled_models: provider.disabled_models,
    manual_models: provider.manual_models,
    updated_at: provider.updated_at,
  };
}

export function isValidModel(value: unknown): value is string {
  return typeof value === "string" && MODEL_PATTERN.test(value);
}

export function parseModel(value: unknown, field = "model"): string {
  if (!isValidModel(value)) {
    throw new ValidationError(
      `${field} must be 1-200 characters of letters, digits, or . _ : / @ + -`,
    );
  }
  return value;
}

function parseName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("name must be a string");
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    throw new ValidationError(`name must be 1-${NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

/** http(s) only, no embedded credentials, query or fragment; trailing slashes dropped. */
function parseBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("base_url must be a string");
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError("base_url must be an absolute http(s) URL");
  }
  if (
    trimmed.length > BASE_URL_MAX_LENGTH
    || (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new ValidationError("base_url must be an http(s) URL without credentials, query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function parseApiKey(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("api_key must be a string");
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > API_KEY_MAX_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    throw new ValidationError(`api_key must be 1-${API_KEY_MAX_LENGTH} characters without control characters`);
  }
  return trimmed;
}

function parseModelList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MODEL_LIST_MAX) {
    throw new ValidationError(`${field} must be an array of at most ${MODEL_LIST_MAX} model ids`);
  }
  return [...new Set(value.map((item) => parseModel(item, field)))];
}

export function parseProviderCreate(body: Record<string, unknown>): ProviderCreate {
  return {
    name: parseName(body.name),
    base_url: parseBaseUrl(body.base_url),
    api_key: body.api_key === undefined || body.api_key === null ? null : parseApiKey(body.api_key),
    manual_models: body.manual_models === undefined ? [] : parseModelList(body.manual_models, "manual_models"),
  };
}

export function parseProviderPatch(body: Record<string, unknown>): ProviderPatch {
  const patch: ProviderPatch = {};
  if (body.name !== undefined) patch.name = parseName(body.name);
  if (body.base_url !== undefined) patch.base_url = parseBaseUrl(body.base_url);
  if (body.api_key !== undefined) patch.api_key = body.api_key === null ? null : parseApiKey(body.api_key);
  if (body.disabled_models !== undefined) {
    patch.disabled_models = parseModelList(body.disabled_models, "disabled_models");
  }
  if (body.manual_models !== undefined) {
    patch.manual_models = parseModelList(body.manual_models, "manual_models");
  }
  return patch;
}

export function parseSelection(body: Record<string, unknown>): ModelSelection {
  if (typeof body.provider_id !== "string" || body.provider_id.length === 0) {
    throw new ValidationError("provider_id must be a provider id");
  }
  return { provider_id: body.provider_id, model: parseModel(body.model) };
}

function emptyConfig(): ProviderConfig {
  return { providers: [], selection: null };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validates one stored entry; malformed entries are dropped rather than trusted. */
function parseStoredProvider(value: unknown): StoredProvider | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  try {
    if (typeof record.id !== "string" || record.id.length === 0) return null;
    if (typeof record.updated_at !== "string") return null;
    if (!isStringArray(record.disabled_models) || !isStringArray(record.manual_models)) return null;
    return {
      id: record.id,
      name: parseName(record.name),
      base_url: parseBaseUrl(record.base_url),
      api_key: record.api_key === null ? null : parseApiKey(record.api_key),
      disabled_models: parseModelList(record.disabled_models, "disabled_models"),
      manual_models: parseModelList(record.manual_models, "manual_models"),
      updated_at: record.updated_at,
    };
  } catch {
    return null;
  }
}

/** The pre-list document: one Z.AI key plus its default model. */
function migrateLegacyConfig(record: Record<string, unknown>): ProviderConfig | null {
  if (!isValidModel(record.model) || typeof record.updated_at !== "string") return null;
  try {
    const provider: StoredProvider = {
      id: LEGACY_PROVIDER_ID,
      name: LEGACY_PROVIDER_NAME,
      base_url: parseBaseUrl(record.base_url),
      api_key: parseApiKey(record.api_key),
      disabled_models: [],
      manual_models: [...new Set([...LEGACY_MODELS, record.model])],
      updated_at: record.updated_at,
    };
    return { providers: [provider], selection: { provider_id: provider.id, model: record.model } };
  } catch {
    return null;
  }
}

function parseStoredConfig(raw: string): ProviderConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyConfig();
  }
  if (typeof value !== "object" || value === null) return emptyConfig();
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.providers)) return migrateLegacyConfig(record) ?? emptyConfig();

  const providers = record.providers
    .map(parseStoredProvider)
    .filter((provider): provider is StoredProvider => provider !== null);
  const stored = record.selection as Record<string, unknown> | null | undefined;
  const selection =
    typeof stored === "object"
    && stored !== null
    && isValidModel(stored.model)
    && providers.some((provider) => provider.id === stored.provider_id)
      ? { provider_id: stored.provider_id as string, model: stored.model }
      : null;
  return { providers, selection };
}

export class ProviderNotFoundError extends Error {}

/**
 * Providers, their keys and the global model selection live in one 0600 JSON
 * file. Every mutation is a serialized read-modify-write followed by an atomic
 * rename, so concurrent requests can never interleave or resurrect a key.
 */
export class ProviderStore {
  readonly configDirectory: string;

  protected queue: Promise<unknown> = Promise.resolve();

  constructor(configDirectory: string = defaultConfigDirectory()) {
    this.configDirectory = configDirectory;
  }

  private get configPath(): string {
    return join(this.configDirectory, CONFIG_FILE);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async load(): Promise<ProviderConfig> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch {
      return emptyConfig();
    }
    return parseStoredConfig(raw);
  }

  async get(id: string): Promise<StoredProvider | null> {
    return (await this.load()).providers.find((provider) => provider.id === id) ?? null;
  }

  private async write(config: ProviderConfig): Promise<void> {
    await mkdir(this.configDirectory, { recursive: true });
    await chmod(this.configDirectory, 0o700);
    const tempPath = join(this.configDirectory, `.${CONFIG_FILE}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.configPath);
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }

  private mutate<T>(operation: (config: ProviderConfig) => T): Promise<T> {
    return this.runExclusive(async () => {
      const config = await this.load();
      const result = operation(config);
      await this.write(config);
      return result;
    });
  }

  create(input: ProviderCreate): Promise<StoredProvider> {
    return this.mutate((config) => {
      const provider: StoredProvider = {
        id: randomUUID(),
        ...input,
        disabled_models: [],
        updated_at: new Date().toISOString(),
      };
      config.providers.push(provider);
      return provider;
    });
  }

  /** A new base_url or key drops the provider's cached model list (credentialsChanged). */
  update(id: string, patch: ProviderPatch): Promise<{ provider: StoredProvider; credentialsChanged: boolean }> {
    return this.mutate((config) => {
      const index = config.providers.findIndex((provider) => provider.id === id);
      if (index === -1) throw new ProviderNotFoundError();
      const current = config.providers[index];
      const baseUrlChanged = patch.base_url !== undefined && patch.base_url !== current.base_url;
      const apiKey = patch.api_key !== undefined ? patch.api_key : current.api_key;
      const provider: StoredProvider = {
        ...current,
        ...patch,
        api_key: apiKey,
        updated_at: new Date().toISOString(),
      };
      config.providers[index] = provider;
      return { provider, credentialsChanged: baseUrlChanged || apiKey !== current.api_key };
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((config) => {
      const before = config.providers.length;
      config.providers = config.providers.filter((provider) => provider.id !== id);
      if (config.providers.length === before) throw new ProviderNotFoundError();
      if (config.selection?.provider_id === id) config.selection = null;
    });
  }

  setSelection(selection: ModelSelection): Promise<ModelSelection> {
    return this.mutate((config) => {
      if (!config.providers.some((provider) => provider.id === selection.provider_id)) {
        throw new ProviderNotFoundError();
      }
      config.selection = selection;
      return selection;
    });
  }
}
