export type ProviderConfig = {
  provider: string;
  base_url: string;
  model: string;
  has_api_key: boolean;
};

export type ProviderUpdate = {
  model: string;
  api_key?: string;
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

export async function fetchProvider(): Promise<ProviderConfig> {
  const response = await fetch("/api/provider");
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()) as ProviderConfig;
}

export async function updateProvider(update: ProviderUpdate): Promise<void> {
  const response = await fetch("/api/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!response.ok) throw new Error(await errorText(response));
}

export async function deleteProvider(): Promise<void> {
  const response = await fetch("/api/provider", { method: "DELETE" });
  if (!response.ok) throw new Error(await errorText(response));
}
