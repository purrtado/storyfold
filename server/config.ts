import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_NAME = "zai";
export const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const DEFAULT_MODEL = "glm-5.3";

const CONFIG_FILE = "config.json";
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const API_KEY_MAX_LENGTH = 512;

export interface ProviderSettings {
  base_url: string;
  model: string;
  api_key: string;
  updated_at: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

/**
 * Both ids are documented as supported by every GLM Coding Plan tier:
 * https://docs.z.ai/devpack/overview
 */
export const MODEL_CATALOG: readonly ModelOption[] = [
  { id: "glm-5.3", name: "GLM-5.3" },
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
];

export interface PublicProviderConfig {
  provider: string;
  base_url: string;
  model: string;
  models: readonly ModelOption[];
  has_api_key: boolean;
}

export function defaultConfigDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const root = xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config");
  return join(root, "storyfold");
}

export function validateModel(value: unknown): string | null {
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) {
    return "model must be 1-128 characters of letters, digits, dot, underscore, colon or dash";
  }
  return null;
}

export function validateApiKey(value: unknown): string | null {
  if (typeof value !== "string") return "api_key must be a string";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "api_key must not be blank";
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || trimmed.length > API_KEY_MAX_LENGTH) {
    return `api_key must be 1-${API_KEY_MAX_LENGTH} characters without control characters`;
  }
  return null;
}

export function publicConfig(settings: ProviderSettings | null): PublicProviderConfig {
  if (!settings) {
    return {
      provider: PROVIDER_NAME,
      base_url: ZAI_BASE_URL,
      model: DEFAULT_MODEL,
      models: MODEL_CATALOG,
      has_api_key: false,
    };
  }
  return {
    provider: PROVIDER_NAME,
    base_url: ZAI_BASE_URL,
    model: settings.model,
    models: MODEL_CATALOG,
    has_api_key: true,
  };
}

/**
 * Parses and fully validates a stored config document. Anything malformed
 * (wrong types, blank key, unknown shape) is rejected as unconfigured.
 */
function parseStoredConfig(raw: string): ProviderSettings | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string") return null;
  if (typeof record.api_key !== "string" || record.api_key.length === 0) return null;
  if (typeof record.base_url !== "string" || record.base_url.length === 0) return null;
  if (typeof record.updated_at !== "string") return null;
  if (validateModel(record.model) !== null) return null;
  if (validateApiKey(record.api_key) !== null) return null;
  return {
    base_url: record.base_url,
    model: record.model,
    api_key: record.api_key,
    updated_at: record.updated_at,
  };
}

export class CredentialStore {
  readonly configDirectory: string;

  constructor(configDirectory: string = defaultConfigDirectory()) {
    this.configDirectory = configDirectory;
  }

  private get configPath(): string {
    return join(this.configDirectory, CONFIG_FILE);
  }

  /** Returns the stored settings, or null when absent or invalid on disk. */
  async load(): Promise<ProviderSettings | null> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch {
      return null;
    }
    return parseStoredConfig(raw);
  }

  /**
   * Atomically replaces the config file. Omitting api_key preserves the
   * previously stored key; a brand-new configuration must provide one.
   */
  async save(input: { model: string; api_key?: string }): Promise<ProviderSettings> {
    if (validateModel(input.model) !== null) {
      throw new Error("invalid model");
    }
    let apiKey = input.api_key !== undefined ? input.api_key.trim() : undefined;
    if (apiKey === undefined) {
      apiKey = (await this.load())?.api_key;
    }
    if (apiKey === undefined || validateApiKey(apiKey) !== null) {
      throw new Error("API key required");
    }

    await mkdir(this.configDirectory, { recursive: true });
    await chmod(this.configDirectory, 0o700);

    const settings: ProviderSettings = {
      base_url: ZAI_BASE_URL,
      model: input.model,
      api_key: apiKey,
      updated_at: new Date().toISOString(),
    };
    const tempPath = join(this.configDirectory, `.${CONFIG_FILE}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.configPath);
    } finally {
      await unlink(tempPath).catch(() => {});
    }
    return settings;
  }

  /** Removes the stored configuration. Idempotent. */
  async remove(): Promise<void> {
    await unlink(this.configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
