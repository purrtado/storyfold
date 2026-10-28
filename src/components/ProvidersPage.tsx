import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import { AppHeader } from "./AppHeader";
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from "./Collapsible";
import {
  createProvider,
  deleteProvider,
  fetchModels,
  fetchProviders,
  updateProvider,
  type ModelListing,
  type Provider,
  type ProviderApi,
  type ProviderPatch,
} from "../lib/providers";
import "./settings.css";

const inputClass = "min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm";
const buttonClass =
  "pressable inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm disabled:pointer-events-none disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised";
const primaryButtonClass =
  "pressable inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg disabled:pointer-events-none disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90";

const API_LABELS: Record<ProviderApi, string> = {
  openai: "OpenAI chat completions",
  anthropic: "Anthropic Messages",
};

const BASE_URL_PLACEHOLDERS: Record<ProviderApi, string> = {
  openai: "https://api.example.com/v1",
  anthropic: "https://api.example.com",
};

const PRESETS: { label: string; name: string; api: ProviderApi; base_url: string }[] = [
  { label: "Custom", name: "", api: "openai", base_url: "" },
  { label: "Anthropic", name: "Anthropic", api: "anthropic", base_url: "https://api.anthropic.com" },
  { label: "OpenAI", name: "OpenAI", api: "openai", base_url: "https://api.openai.com/v1" },
  { label: "OpenRouter", name: "OpenRouter", api: "openai", base_url: "https://openrouter.ai/api/v1" },
  { label: "Z.AI Coding Plan", name: "Z.AI Coding Plan", api: "openai", base_url: "https://api.z.ai/api/coding/paas/v4" },
  { label: "Ollama", name: "Ollama", api: "openai", base_url: "http://localhost:11434/v1" },
  { label: "LM Studio", name: "LM Studio", api: "openai", base_url: "http://localhost:1234/v1" },
];

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function NewProviderForm(props: { onCreated: (provider: Provider) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [api, setApi] = useState<ProviderApi>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const id = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      props.onCreated(
        await createProvider({ name, api, base_url: baseUrl, ...(apiKey.trim() ? { api_key: apiKey } : {}) }),
      );
    } catch (cause) {
      setError(errorText(cause, "Could not add the provider."));
      setPending(false);
    }
  };

  return (
    <form className="grid gap-3 rounded-xl border border-border p-3" onSubmit={submit} aria-label="New provider">
      <label className="grid gap-1 text-sm font-medium" htmlFor={`${id}-preset`}>
        Preset
        <select
          id={`${id}-preset`}
          className={inputClass}
          defaultValue="Custom"
          onChange={(event) => {
            const preset = PRESETS.find((item) => item.label === event.target.value);
            if (!preset) return;
            setName(preset.name);
            setApi(preset.api);
            setBaseUrl(preset.base_url);
          }}
        >
          {PRESETS.map((preset) => <option key={preset.label}>{preset.label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium" htmlFor={`${id}-name`}>
        Name
        <input id={`${id}-name`} className={inputClass} value={name} required autoFocus onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="grid gap-1 text-sm font-medium" htmlFor={`${id}-api`}>
        API
        <select
          id={`${id}-api`}
          className={inputClass}
          value={api}
          onChange={(event) => setApi(event.target.value as ProviderApi)}
        >
          {(Object.keys(API_LABELS) as ProviderApi[]).map((value) => (
            <option key={value} value={value}>{API_LABELS[value]}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium" htmlFor={`${id}-url`}>
        Base URL
        <input
          id={`${id}-url`}
          className={`${inputClass} font-mono`}
          value={baseUrl}
          required
          inputMode="url"
          placeholder={BASE_URL_PLACEHOLDERS[api]}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-sm font-medium" htmlFor={`${id}-key`}>
        API key
        <input
          id={`${id}-key`}
          type="password"
          className={inputClass}
          value={apiKey}
          placeholder="Optional for local servers"
          autoComplete="new-password"
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      {error && <p className="m-0 text-sm text-muted" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass} disabled={pending}>
          {pending ? "Adding…" : "Add provider"}
        </button>
        <button type="button" className={buttonClass} disabled={pending} onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ProviderSettingsForm(props: {
  provider: Provider;
  /** credentialsChanged: the save touched the key or base URL, so the server dropped its model list. */
  onSaved: (provider: Provider, credentialsChanged: boolean) => void;
  onDeleted: () => void;
}) {
  const { provider } = props;
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"idle" | "save" | "key" | "delete">("idle");
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const id = useId();
  const urlChanged = baseUrl.trim() !== provider.base_url;
  const changed = name.trim() !== provider.name || urlChanged || apiKey.trim() !== "";

  const run = async (kind: "save" | "key", patch: ProviderPatch, success: string) => {
    setPending(kind);
    setFeedback(null);
    try {
      const saved = await updateProvider(provider.id, patch);
      props.onSaved(saved, patch.api_key !== undefined || patch.base_url !== undefined);
      setName(saved.name);
      setBaseUrl(saved.base_url);
      setApiKey("");
      setFeedback({ kind: "success", message: success });
    } catch (cause) {
      setFeedback({ kind: "error", message: errorText(cause, "Could not save the provider.") });
    } finally {
      setPending("idle");
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(
      "save",
      {
        ...(name.trim() !== provider.name ? { name } : {}),
        ...(urlChanged ? { base_url: baseUrl } : {}),
        ...(apiKey.trim() ? { api_key: apiKey } : {}),
      },
      "Saved.",
    );
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${provider.name}” and its saved key?`)) return;
    setPending("delete");
    setFeedback(null);
    try {
      await deleteProvider(provider.id);
      props.onDeleted();
    } catch (cause) {
      setFeedback({ kind: "error", message: errorText(cause, "Could not delete the provider.") });
      setPending("idle");
    }
  };

  return (
    <form className="grid gap-3" onSubmit={save}>
      <fieldset className="grid gap-3 border-0 p-0" disabled={pending !== "idle"}>
        <label className="grid gap-1 text-sm font-medium" htmlFor={`${id}-name`}>
          Name
          <input id={`${id}-name`} className={inputClass} value={name} required onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm font-medium" htmlFor={`${id}-url`}>
          Base URL
          <input
            id={`${id}-url`}
            className={`${inputClass} font-mono`}
            value={baseUrl}
            required
            inputMode="url"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm font-medium" htmlFor={`${id}-key`}>
          API key
          <input
            id={`${id}-key`}
            type="password"
            className={inputClass}
            value={apiKey}
            placeholder={provider.has_api_key ? "Saved on this machine. Enter a new key to replace it" : "None saved"}
            autoComplete="new-password"
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryButtonClass} disabled={!changed}>
            {pending === "save" ? "Saving…" : "Save"}
          </button>
          {provider.has_api_key && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => void run("key", { api_key: null }, "API key removed.")}
            >
              {pending === "key" ? "Removing…" : "Remove key"}
            </button>
          )}
          <button type="button" className={`${buttonClass} text-muted`} onClick={() => void remove()}>
            <Trash2 className="size-4" aria-hidden="true" />
            {pending === "delete" ? "Deleting…" : "Delete provider"}
          </button>
        </div>
        <p role={feedback?.kind === "error" ? "alert" : "status"} className="m-0 min-h-5 text-sm text-muted">
          {feedback?.message}
        </p>
      </fieldset>
    </form>
  );
}

function ProviderModels(props: {
  provider: Provider;
  open: boolean;
  /** Bumped after each key or base URL save. */
  credentialsRevision: number;
  onSaved: (provider: Provider) => void;
}) {
  const { provider, onSaved } = props;
  const [listing, setListing] = useState<ModelListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [filter, setFilter] = useState("");
  const [manualId, setManualId] = useState("");
  const latestSave = useRef(0);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const latestLoad = useRef(0);
  const id = useId();

  // Only the newest load may write state; an older one can finish last with
  // results for a previous base URL or key.
  const load = useCallback(async (refresh: boolean) => {
    const sequence = ++latestLoad.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = await fetchModels(provider.id, refresh);
      if (sequence === latestLoad.current) setListing(next);
    } catch (cause) {
      if (sequence === latestLoad.current) setLoadError(errorText(cause, "Could not load models."));
    } finally {
      if (sequence === latestLoad.current) setLoading(false);
    }
  }, [provider.id]);

  // A key or base URL save empties the server cache; refetch after each one.
  useEffect(() => {
    if (props.open) void load(false);
  }, [props.open, load, props.credentialsRevision]);

  // Each PATCH carries a whole list, so requests are queued to reach the server
  // in click order; only the newest response or rollback may land locally.
  const save = async (patch: ProviderPatch, optimistic: Provider) => {
    const sequence = ++latestSave.current;
    setSaveError("");
    onSaved(optimistic);
    try {
      const request = saveQueue.current.then(() => updateProvider(provider.id, patch));
      saveQueue.current = request.catch(() => {});
      const saved = await request;
      if (sequence === latestSave.current) onSaved(saved);
      return true;
    } catch (cause) {
      if (sequence === latestSave.current) {
        onSaved(provider);
        setSaveError(errorText(cause, "Could not save models."));
      }
      return false;
    }
  };

  const setDisabled = (ids: string[], disabled: boolean) => {
    const next = new Set(provider.disabled_models);
    for (const model of ids) {
      if (disabled) next.add(model);
      else next.delete(model);
    }
    const disabled_models = [...next];
    void save({ disabled_models }, { ...provider, disabled_models });
  };

  const setManual = async (manual_models: string[]) => {
    const saved = await save({ manual_models }, { ...provider, manual_models });
    if (saved) void load(false);
    return saved;
  };

  const ids = [...new Set([...(listing?.models.map((model) => model.id) ?? []), ...provider.manual_models])]
    .sort((a, b) => a.localeCompare(b));
  const disabled = new Set(provider.disabled_models);
  const manual = new Set(provider.manual_models);
  const query = filter.trim().toLowerCase();
  const visible = query ? ids.filter((model) => model.toLowerCase().includes(query)) : ids;
  const enabledCount = ids.filter((model) => !disabled.has(model)).length;

  return (
    <section className="grid gap-3 border-bs border-border pbs-3" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p id={`${id}-title`} className="theme-label">Models</p>
          <p className="theme-desc">
            {listing ? `${enabledCount} of ${ids.length} shown in the composer` : "Listed from the provider’s /models endpoint."}
            {listing?.fetched_at && ` · Updated ${new Date(listing.fetched_at).toLocaleTimeString()}`}
          </p>
        </div>
        <button type="button" className={buttonClass} disabled={loading} onClick={() => void load(true)}>
          <RefreshCw className="size-4" aria-hidden="true" />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {(loadError || listing?.error) && (
        <p className="m-0 text-sm text-muted" role="alert">
          {loadError || listing?.error}
          {listing?.error && " Models added by hand below still work."}
        </p>
      )}

      {ids.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              className={`${inputClass} min-w-0 flex-[1_1_12rem]`}
              value={filter}
              placeholder="Filter models"
              aria-label={`Filter ${provider.name} models`}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button type="button" className={buttonClass} disabled={visible.length === 0} onClick={() => setDisabled(visible, false)}>
              Enable {query ? "matching" : "all"}
            </button>
            <button type="button" className={buttonClass} disabled={visible.length === 0} onClick={() => setDisabled(visible, true)}>
              Disable {query ? "matching" : "all"}
            </button>
          </div>
          <ul className="m-0 grid max-h-80 list-none overflow-y-auto rounded-lg border border-border p-1" aria-label={`${provider.name} models`}>
            {visible.map((model) => (
              <li key={model} className="flex min-h-10 items-center gap-2 rounded-md ps-2 pe-1 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]" title={model}>{model}</span>
                {manual.has(model) && (
                  <>
                    <span className="flex-none text-xs text-muted">added by hand</span>
                    <button
                      type="button"
                      className="pressable inline-flex size-7 flex-none items-center justify-center rounded-md text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                      aria-label={`Remove ${model}`}
                      onClick={() => void setManual(provider.manual_models.filter((item) => item !== model))}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </>
                )}
                <input
                  type="checkbox"
                  role="switch"
                  className="prompt-switch"
                  aria-label={`Show ${model} in the composer`}
                  checked={!disabled.has(model)}
                  onChange={(event) => setDisabled([model], !event.target.checked)}
                />
              </li>
            ))}
            {visible.length === 0 && <li className="p-2 text-sm text-muted">No models match.</li>}
          </ul>
        </>
      )}
      {listing && ids.length === 0 && !listing.error && (
        <p className="m-0 text-sm text-muted">The provider listed no models. Add model ids by hand below.</p>
      )}

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const model = manualId.trim();
          if (!model || manual.has(model)) return;
          void setManual([...provider.manual_models, model]).then((saved) => {
            if (saved) setManualId("");
          });
        }}
      >
        <input
          className={`${inputClass} min-w-0 flex-[1_1_12rem] font-mono`}
          value={manualId}
          placeholder="Add a model id by hand"
          aria-label={`Add a ${provider.name} model id`}
          onChange={(event) => setManualId(event.target.value)}
        />
        <button type="submit" className={buttonClass} disabled={!manualId.trim()}>
          <Plus className="size-4" aria-hidden="true" />Add
        </button>
      </form>
      {saveError && <p className="m-0 text-sm text-muted" role="alert">{saveError}</p>}
    </section>
  );
}

export function ProvidersPage(props: { onOpenSidebar: () => void }) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [credentialRevisions, setCredentialRevisions] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoadError("");
    try {
      setProviders((await fetchProviders()).providers);
    } catch (cause) {
      setLoadError(errorText(cause, "Could not load providers."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (saved: Provider) =>
    setProviders((current) => current?.map((item) => (item.id === saved.id ? saved : item)) ?? null);

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="Settings" onOpenSidebar={props.onOpenSidebar} />
      <div className="chat-scroll settings-scroll">
        <main className="settings-main">
          <h2 className="settings-heading">Providers</h2>
          <section className="theme-group grid gap-4" aria-labelledby="providers-title">
            <div className="theme-body">
              <div className="theme-copy">
                <p id="providers-title" className="theme-label">AI providers</p>
                <p className="theme-desc">
                  Any OpenAI chat-completions or Anthropic Messages endpoint works. Choose which provider and model narrate from the composer.
                </p>
              </div>
              <button type="button" className={buttonClass} disabled={providers === null || adding} onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden="true" />Add provider
              </button>
            </div>

            {adding && (
              <NewProviderForm
                onCancel={() => setAdding(false)}
                onCreated={(provider) => {
                  setProviders((current) => [...(current ?? []), provider]);
                  setAdding(false);
                  setExpandedId(provider.id);
                }}
              />
            )}

            {providers === null ? (
              loadError ? (
                <div className="grid justify-items-start gap-3" role="alert">
                  <p className="m-0 text-sm text-muted">{loadError}</p>
                  <button type="button" className={buttonClass} onClick={() => void load()}>Try again</button>
                </div>
              ) : (
                <p className="m-0 text-sm text-muted" role="status">Loading providers…</p>
              )
            ) : providers.length === 0 ? (
              !adding && <p className="m-0 text-sm text-muted">No providers yet. Add one to start playing.</p>
            ) : (
              <ul className="m-0 grid list-none gap-3 p-0">
                {providers.map((provider) => (
                  <li key={provider.id} className="rounded-xl border border-border">
                    <Collapsible
                      open={expandedId === provider.id}
                      onOpenChange={() => setExpandedId((current) => (current === provider.id ? null : provider.id))}
                    >
                      <CollapsibleTrigger className="pressable flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-xl p-3 text-start">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{provider.name}</span>
                          <span className="block truncate font-mono text-xs text-muted">{provider.base_url}</span>
                          <span className="block truncate text-xs text-muted">{API_LABELS[provider.api]}</span>
                        </span>
                        <span className="flex-none text-xs text-muted">{provider.has_api_key ? "Key saved" : "No key"}</span>
                        <CollapsibleIndicator />
                      </CollapsibleTrigger>
                      <CollapsibleContent contentClassName="grid gap-3 px-3 pbe-3">
                        <div className="border-bs border-border pbs-3">
                          <ProviderSettingsForm
                            provider={provider}
                            onSaved={(saved, credentialsChanged) => {
                              replace(saved);
                              if (credentialsChanged) {
                                setCredentialRevisions((current) => ({ ...current, [saved.id]: (current[saved.id] ?? 0) + 1 }));
                              }
                            }}
                            onDeleted={() => setProviders((current) => current?.filter((item) => item.id !== provider.id) ?? null)}
                          />
                        </div>
                        <ProviderModels
                          provider={provider}
                          open={expandedId === provider.id}
                          credentialsRevision={credentialRevisions[provider.id] ?? 0}
                          onSaved={replace}
                        />
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="theme-desc [margin-block-start:1rem] max-w-prose">
            Storyfold is a local, single-user install. Providers and their API keys are stored by the Storyfold
            server on this machine; keys are never sent back to the browser.
          </p>
        </main>
      </div>
    </div>
  );
}
