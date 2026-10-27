export type ProviderApi = "openai" | "anthropic";

export type Provider = {
  id: string;
  name: string;
  api: ProviderApi;
  base_url: string;
  has_api_key: boolean;
  disabled_models: string[];
  manual_models: string[];
  updated_at: string;
};

export type ModelSelection = {
  provider_id: string;
  model: string;
};

export type ProviderList = {
  providers: Provider[];
  selection: ModelSelection | null;
};

export type ModelEntry = {
  id: string;
  enabled: boolean;
  manual: boolean;
};

export type ModelListing = {
  models: ModelEntry[];
  fetched_at: string | null;
  /** The provider's own list is missing or stale; manual and last-known models are still listed. */
  error: string | null;
};

export type ProviderCreate = {
  name: string;
  api: ProviderApi;
  base_url: string;
  api_key?: string;
};

export type ProviderPatch = {
  name?: string;
  base_url?: string;
  /** null removes the saved key; omitted keeps it unless base_url changes. */
  api_key?: string | null;
  disabled_models?: string[];
  manual_models?: string[];
};

async function errorText(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  } catch {
    // Non-JSON failure body falls through to the generic message.
  }
  return `Request failed (HTTP ${response.status}).`;
}

async function request<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }
      : {}),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()) as T;
}

export function fetchProviders(): Promise<ProviderList> {
  return request<ProviderList>("/api/providers");
}

export async function createProvider(input: ProviderCreate): Promise<Provider> {
  return (await request<{ provider: Provider }>("/api/providers", { method: "POST", body: input })).provider;
}

export async function updateProvider(id: string, patch: ProviderPatch): Promise<Provider> {
  const path = `/api/providers/${encodeURIComponent(id)}`;
  return (await request<{ provider: Provider }>(path, { method: "PATCH", body: patch })).provider;
}

export async function deleteProvider(id: string): Promise<void> {
  await request(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchModels(id: string, refresh = false): Promise<ModelListing> {
  return request<ModelListing>(`/api/providers/${encodeURIComponent(id)}/models${refresh ? "?refresh=1" : ""}`);
}

export async function saveSelection(selection: ModelSelection): Promise<void> {
  await request("/api/model-selection", { method: "PUT", body: selection });
}
