import * as Popover from "@radix-ui/react-popover";
import { Gauge } from "lucide-react";
import type { MessageUsage } from "../../shared/domain";
import { NARRATION_TOKEN_BUDGET } from "../../shared/narration";

const SEGMENTS = [
  { key: "system", label: "System prompt", color: "var(--stat-blue)" },
  { key: "history", label: "Chat history", color: "var(--stat-teal)" },
  { key: "context", label: "Reply context", color: "var(--stat-amber)" },
] as const;

const triggerClass =
  "pressable inline-flex min-h-8 flex-none items-center gap-1.5 rounded-full px-2 text-xs tabular-nums text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground data-[state=open]:bg-surface data-[state=open]:text-foreground";

function compact(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function percent(part: number, whole: number): number {
  return Math.round((part / whole) * 100);
}

export function PromptUsage({ usage, pending }: { usage: MessageUsage; pending: boolean }) {
  const { estimate, provider } = usage;
  const total = estimate.system + estimate.history + estimate.context;
  const scale = Math.max(NARRATION_TOKEN_BUDGET, total);
  const reported = provider && provider.prompt_tokens > 0 ? provider : null;
  const label = reported ? `${compact(total)} · ${percent(reported.cached_tokens, reported.prompt_tokens)}%` : compact(total);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={triggerClass} aria-label={`Prompt tokens: ${label}`} title="Prompt tokens of the last narration">
          <Gauge className="size-4 flex-none" aria-hidden="true" />
          <span>{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-border bg-raised p-4 text-sm text-foreground shadow-[0_0.5rem_2rem_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
        >
          <h2 className="m-0 text-sm font-semibold">Prompt tokens</h2>

          <div
            role="img"
            aria-label={`${total.toLocaleString()} of ${NARRATION_TOKEN_BUDGET.toLocaleString()} token budget used`}
            className="mbs-3 flex h-2.5 overflow-clip rounded-full bg-surface"
          >
            {SEGMENTS.map(({ key, color }) => (
              <span key={key} className="h-full flex-none" style={{ inlineSize: `${(estimate[key] / scale) * 100}%`, background: color }} />
            ))}
          </div>

          <dl className="m-0 mbs-3 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1.5 tabular-nums">
            {SEGMENTS.map(({ key, label: name, color }) => (
              <div key={key} className="col-span-3 grid grid-cols-subgrid items-center">
                <span className="size-2.5 rounded-full" style={{ background: color }} aria-hidden="true" />
                <dt className="text-muted">{name}</dt>
                <dd className="m-0 text-end">{estimate[key].toLocaleString()}</dd>
              </div>
            ))}
            <div className="col-span-3 grid grid-cols-subgrid items-center border-bs border-border pbs-1.5 font-medium">
              <dt className="col-span-2">Total</dt>
              <dd className="m-0 text-end">
                {total.toLocaleString()} <span className="font-normal text-muted">of {NARRATION_TOKEN_BUDGET.toLocaleString()}</span>
              </dd>
            </div>
          </dl>

          <h3 className="m-0 mbs-4 text-xs font-semibold uppercase tracking-wide text-muted">Provider</h3>
          {provider ? (
            <dl className="m-0 mbs-2 grid grid-cols-[1fr_auto] gap-x-2 gap-y-1.5 tabular-nums">
              <dt className="text-muted">Prompt</dt>
              <dd className="m-0 text-end">{provider.prompt_tokens.toLocaleString()}</dd>
              <dt className="text-muted">Cached</dt>
              <dd className="m-0 text-end">
                {provider.cached_tokens.toLocaleString()}
                {provider.prompt_tokens > 0 && <span className="text-muted"> ({percent(provider.cached_tokens, provider.prompt_tokens)}%)</span>}
              </dd>
              <dt className="text-muted">Output</dt>
              <dd className="m-0 text-end">{provider.completion_tokens.toLocaleString()}</dd>
            </dl>
          ) : (
            <p className="m-0 mbs-2 text-muted">
              {pending ? "Waiting for the provider…" : "The provider reported no usage for this reply."}
            </p>
          )}

          <p className="m-0 mbs-4 text-xs leading-5 text-muted">
            Estimates are counted locally. Provider numbers are what the provider billed.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
