import { useCallback, useEffect, useState } from "react";
import {
  fetchModels,
  fetchProviders,
  saveSelection,
  type ModelListing,
  type ModelSelection,
  type Provider,
} from "./providers";

/** undefined while loading; a string is a failed request to the local server. */
export type ProviderModels = ModelListing | string | undefined;

export type ModelPickerState = {
  status: "loading" | "ready" | "error";
  providers: Provider[];
  models: Record<string, ProviderModels>;
  /** The saved choice when still usable, else the first enabled model; null when nothing is usable. */
  selection: ModelSelection | null;
  select: (selection: ModelSelection) => void;
  saveError: string;
};

function enabledIds(models: ProviderModels): string[] | null {
  return typeof models === "object" ? models.models.filter((model) => model.enabled).map((model) => model.id) : null;
}

/**
 * The global provider/model choice. Model lists are fetched for every provider
 * up front (the server caches them), so hovering a provider shows its models
 * without a spinner.
 */
export function useModelSelection(): ModelPickerState {
  const [status, setStatus] = useState<ModelPickerState["status"]>("loading");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [saved, setSaved] = useState<ModelSelection | null>(null);
  const [models, setModels] = useState<Record<string, ProviderModels>>({});
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    let active = true;
    fetchProviders().then(
      (list) => {
        if (!active) return;
        setProviders(list.providers);
        setSaved(list.selection);
        setStatus("ready");
        for (const provider of list.providers) {
          fetchModels(provider.id).then(
            (listing) => { if (active) setModels((current) => ({ ...current, [provider.id]: listing })); },
            (error: unknown) => {
              if (!active) return;
              const message = error instanceof Error ? error.message : "Could not load models.";
              setModels((current) => ({ ...current, [provider.id]: message }));
            },
          );
        }
      },
      () => { if (active) setStatus("error"); },
    );
    return () => { active = false; };
  }, []);

  const select = useCallback((next: ModelSelection) => {
    setSaved(next);
    setSaveError("");
    saveSelection(next).catch((error: unknown) => {
      setSaveError(error instanceof Error ? error.message : "Could not save the model choice.");
    });
  }, []);

  // A saved model whose provider is gone or that was switched off falls back to
  // the first enabled model, its own provider first; while its list is unknown
  // (loading or failed) the saved choice is trusted.
  const savedProvider = saved ? providers.find((provider) => provider.id === saved.provider_id) : undefined;
  const savedEnabled = saved && savedProvider ? enabledIds(models[savedProvider.id]) : null;
  let selection: ModelSelection | null = null;
  if (saved && savedProvider && (savedEnabled === null || savedEnabled.includes(saved.model))) {
    selection = saved;
  } else {
    const candidates = savedProvider ? [savedProvider, ...providers.filter((provider) => provider !== savedProvider)] : providers;
    for (const provider of candidates) {
      const first = enabledIds(models[provider.id])?.[0];
      if (first) {
        selection = { provider_id: provider.id, model: first };
        break;
      }
    }
  }

  return { status, providers, models, selection, select, saveError };
}
