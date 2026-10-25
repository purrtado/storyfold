import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { ModelPickerState } from "../lib/useModelSelection";
import "./message-menu.css";

const triggerClass =
  "pressable inline-flex min-h-8 min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-xs text-muted disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground data-[state=open]:bg-surface data-[state=open]:text-foreground";

/** Provider list whose models open in a submenu on hover, click, or ArrowRight. */
export function ModelPicker(props: { picker: ModelPickerState; disabled: boolean }) {
  const { status, providers, models, selection, select, saveError } = props.picker;
  const navigate = useNavigate();

  if (status === "loading") {
    return <span className="px-2 text-xs text-muted" role="status">Loading models…</span>;
  }
  if (status === "error") {
    return <span className="px-2 text-xs text-muted" role="alert">Could not load providers.</span>;
  }
  if (providers.length === 0) {
    return (
      <Link to="/settings/providers" className="px-2 text-xs font-medium text-accent underline underline-offset-2">
        Add a provider
      </Link>
    );
  }

  const selectedProvider = providers.find((provider) => provider.id === selection?.provider_id);
  const label = selection && selectedProvider ? `${selectedProvider.name} · ${selection.model}` : "Choose a model";

  return (
    <div className="flex min-w-0 max-w-full flex-col items-start">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild disabled={props.disabled}>
          <button type="button" className={triggerClass} aria-label={`Model: ${label}`}>
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3.5 flex-none" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="start" sideOffset={4} collisionPadding={12} className="message-menu-content">
            {providers.map((provider) => {
              const listing = models[provider.id];
              const enabled = typeof listing === "object" ? listing.models.filter((model) => model.enabled) : [];
              return (
                <DropdownMenu.Sub key={provider.id}>
                  <DropdownMenu.SubTrigger className="message-menu-item gap-2">
                    <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                    {provider.id === selection?.provider_id && <Check className="size-3.5 flex-none text-accent" aria-label="selected" />}
                    <ChevronRight className="size-3.5 flex-none text-muted" aria-hidden="true" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      sideOffset={6}
                      collisionPadding={12}
                      className="message-menu-content max-w-80 overflow-y-auto [max-block-size:min(24rem,var(--radix-dropdown-menu-content-available-height))]"
                    >
                      {listing === undefined ? (
                        <DropdownMenu.Item disabled className="message-menu-item text-muted">Loading models…</DropdownMenu.Item>
                      ) : typeof listing === "string" ? (
                        <DropdownMenu.Item disabled className="message-menu-item text-muted">{listing}</DropdownMenu.Item>
                      ) : enabled.length === 0 ? (
                        <DropdownMenu.Item disabled className="message-menu-item text-muted">
                          {listing.error ?? "No models enabled."}
                        </DropdownMenu.Item>
                      ) : (
                        <DropdownMenu.RadioGroup
                          value={provider.id === selection?.provider_id ? selection.model : ""}
                          onValueChange={(model) => select({ provider_id: provider.id, model })}
                        >
                          {enabled.map((model) => (
                            <DropdownMenu.RadioItem key={model.id} value={model.id} className="message-menu-item gap-2">
                              <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{model.id}</span>
                              <DropdownMenu.ItemIndicator>
                                <Check className="size-3.5 text-accent" aria-hidden="true" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          ))}
                        </DropdownMenu.RadioGroup>
                      )}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              );
            })}
            <DropdownMenu.Separator className="[margin-block:0.25rem] [block-size:1px] bg-border" />
            <DropdownMenu.Item className="message-menu-item text-muted" onSelect={() => navigate("/settings/providers")}>
              Manage providers…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {saveError && <p className="m-0 px-2 text-xs text-muted" role="alert">{saveError}</p>}
    </div>
  );
}
