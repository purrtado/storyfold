import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AppHeader } from "./AppHeader";
import {
  deleteProvider,
  fetchProvider,
  updateProvider,
  type ProviderConfig,
} from "../lib/provider";

type Feedback = { kind: "success" | "error"; message: string };

const inputClass =
  "block w-full rounded-lg border border-border bg-raised px-3 py-2 text-[15px] text-foreground placeholder:text-muted/60";
const primaryButtonClass =
  "pressable inline-flex cursor-pointer items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:pointer-events-none disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90";
const secondaryButtonClass =
  "pressable inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted disabled:pointer-events-none disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground";

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Something went wrong. Try again.";
}

export function ProvidersPage(props: { onOpenSidebar: () => void }) {
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"idle" | "save" | "remove">("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const modelId = useId();
  const apiKeyId = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const loaded = await fetchProvider();
      setConfig(loaded);
      setModel(loaded.model);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const adopt = (loaded: ProviderConfig, message: Feedback) => {
    setConfig(loaded);
    setModel(loaded.model);
    setApiKey("");
    setFeedback(message);
  };

  const invalidate = (field: "model" | "apiKey", message: string) => {
    setFeedback({ kind: "error", message });
    const input = field === "model" ? modelRef : apiKeyRef;
    input.current?.focus();
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (pending !== "idle" || !config) return;
    const nextModel = model.trim();
    const nextKey = apiKey.trim();
    if (!nextModel) return invalidate("model", "Enter a model.");
    if (!config.has_api_key && !nextKey) {
      return invalidate("apiKey", "An API key is required.");
    }
    setPending("save");
    setFeedback(null);
    try {
      await updateProvider({
        model: nextModel,
        ...(nextKey ? { api_key: nextKey } : {}),
      });
      adopt(await fetchProvider(), { kind: "success", message: "Provider settings saved." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorText(error) });
    } finally {
      setPending("idle");
    }
  };

  const handleRemove = async () => {
    if (pending !== "idle" || !config) return;
    setPending("remove");
    setFeedback(null);
    try {
      await deleteProvider();
      adopt(await fetchProvider(), {
        kind: "success",
        message: "Provider configuration removed.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorText(error) });
    } finally {
      setPending("idle");
    }
  };

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="Settings" onOpenSidebar={props.onOpenSidebar} />

      <div className="chat-scroll settings-scroll">
        <main className="settings-main">
          <h2 className="settings-heading">Providers</h2>

          {loadError ? (
            <div className="theme-group">
              <p className="theme-desc" role="alert">
                {loadError}
              </p>
              <button
                type="button"
                className={`${secondaryButtonClass} [margin-block-start:0.75rem]`}
                onClick={() => void load()}
              >
                Retry
              </button>
            </div>
          ) : !config ? (
            <div className="theme-group">
              <p className="theme-desc" aria-busy="true">
                Loading provider settings…
              </p>
            </div>
          ) : (
            <form className="theme-group" onSubmit={handleSave}>
              <fieldset
                className="flex flex-col gap-4 border-0 p-0 disabled:opacity-60"
                disabled={pending !== "idle"}
              >
                <legend className="sr-only">Z.AI provider</legend>

                <div>
                  <p className="theme-label">Z.AI Coding Plan</p>
                  <p className="theme-desc">
                    Requests are proxied by the local server to{" "}
                    <code className="break-all font-mono text-[0.8125rem]">
                      {config.base_url}
                    </code>
                    .
                  </p>
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor={modelId} className="theme-label">
                    Model
                  </label>
                  <input
                    ref={modelRef}
                    id={modelId}
                    type="text"
                    className={inputClass}
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={feedback?.kind === "error" && !model.trim() ? true : undefined}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor={apiKeyId} className="theme-label">
                    API key
                  </label>
                  <input
                    ref={apiKeyRef}
                    id={apiKeyId}
                    type="password"
                    className={inputClass}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      config.has_api_key
                        ? "Saved on this machine — enter a new key to replace it"
                        : "Required"
                    }
                    autoComplete="new-password"
                  />
                  <p className="theme-desc">
                    Write-only: the saved key stays on this machine and is never
                    sent back to the browser.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" className={primaryButtonClass}>
                    {pending === "save" ? "Saving…" : "Save"}
                  </button>
                  {config.has_api_key && (
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      onClick={handleRemove}
                    >
                      {pending === "remove" ? "Removing…" : "Remove configuration"}
                    </button>
                  )}
                </div>

                <p
                  role={feedback?.kind === "error" ? "alert" : "status"}
                  className={`m-0 min-h-5 text-sm ${
                    feedback?.kind === "error" ? "text-foreground" : "text-muted"
                  }`}
                >
                  {feedback?.message}
                </p>
              </fieldset>
            </form>
          )}

          <p className="theme-desc [margin-block-start:1rem] max-w-prose">
            Storyfold is a local, single-user install. The API key and model are
            stored by the Storyfold server on this machine, which streams replies
            from Z.AI; conversations never leave your device beyond those
            requests.
          </p>
        </main>
      </div>
    </div>
  );
}
