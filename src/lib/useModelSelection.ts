import { useCallback, useEffect, useRef, useState } from "react";
import type { ReasoningLevel } from "../../shared/domain";
import {
  fetchModels,
  fetchProviders,
  saveSelection,
  updateProvider,
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
  /** The selected model's thinking level; null when it does not think. */
  reasoning: ReasoningLevel | null;
  /** The levels the selected model takes; empty when it takes none or they are unknown. */
  reasoningLevels: ReasoningLevel[];
  /** Present only when the selected model has thinking levels. */
  setReasoning?: (level: ReasoningLevel | null) => void;
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
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const latestSave = useRef(0);

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

  // Saves are queued so the server applies them in order; only the newest
  // save may report a failure.
  const queueSave = useCallback((save: () => Promise<unknown>, failure: string) => {
    const sequence = ++latestSave.current;
    setSaveError("");
    const request = saveQueue.current.then(save);
    saveQueue.current = request.catch(() => {});
    request.catch((error: unknown) => {
      if (sequence !== latestSave.current) return;
      setSaveError(error instanceof Error ? error.message : failure);
    });
  }, []);

  const select = useCallback((next: ModelSelection) => {
    setSaved(next);
    queueSave(() => saveSelection(next), "Could not save the model choice.");
  }, [queueSave]);

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

  const selectedProvider = selection ? providers.find((provider) => provider.id === selection.provider_id) : undefined;
  const reasoning = selection && selectedProvider ? selectedProvider.reasoning[selection.model] ?? null : null;
  const listing = selectedProvider ? models[selectedProvider.id] : undefined;
  const reasoningLevels = selection && typeof listing === "object"
    ? listing.models.find((model) => model.id === selection.model)?.reasoning_levels ?? []
    : [];
  const setReasoning = selection && selectedProvider && reasoningLevels.length > 0
    ? (level: ReasoningLevel | null) => {
      const next = { ...selectedProvider.reasoning };
      if (level === null) delete next[selection.model];
      else next[selection.model] = level;
      setProviders((current) => current.map((provider) => provider.id === selectedProvider.id ? { ...provider, reasoning: next } : provider));
      queueSave(() => updateProvider(selectedProvider.id, { reasoning: next }), "Could not save the thinking level.");
    }
    : undefined;

  return { status, providers, models, selection, select, reasoning, reasoningLevels, setReasoning, saveError };
}
