import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useState, type FormEvent, type RefObject } from "react";
import { STAT_COLORS, type StatColor, type StatFields, type StatKind } from "../../shared/domain";
import { type StatFieldsPatch } from "../lib/storyApi";

/** |values| are bounded by the server; checked here only to give inline feedback. */
const STAT_RANGE_LIMIT = 1_000;

const KIND_LABELS: Record<StatKind, string> = {
  character: "Character stat",
  relationship: "Relationship stat",
};

interface StatDraft {
  applies_to: StatKind;
  label: string;
  description: string;
  low_label: string;
  high_label: string;
  min: string;
  max: string;
  default_value: string;
  color: StatColor;
}

function draftOf(stat: StatFields | null): StatDraft {
  return stat
    ? {
      applies_to: stat.applies_to,
      label: stat.label,
      description: stat.description,
      low_label: stat.low_label,
      high_label: stat.high_label,
      min: String(stat.min),
      max: String(stat.max),
      default_value: String(stat.default_value),
      color: stat.color,
    }
    : {
      applies_to: "character",
      label: "",
      description: "",
      low_label: "",
      high_label: "",
      min: "0",
      max: "10",
      default_value: "5",
      color: "slate",
    };
}

function statInteger(raw: string, field: string): number {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(parsed) || Math.abs(parsed) > STAT_RANGE_LIMIT) {
    throw new Error(`${field} must be a whole number between -${STAT_RANGE_LIMIT} and ${STAT_RANGE_LIMIT}.`);
  }
  return parsed;
}

/**
 * The one stat form: scale, labels, and palette color. Bank, world, and
 * campaign callers supply their own save callbacks; this component only owns
 * the form state and error handling. `applies_to` is chosen at creation only.
 */
export function StatDefinitionEditor<T extends StatFields & { id: string }>(props: {
  stat: T | null;
  title: string;
  description: string;
  openerRef?: RefObject<HTMLElement | null>;
  onCreate: (input: StatFields) => Promise<T>;
  onUpdate: (id: string, patch: StatFieldsPatch) => Promise<T>;
  onSaved: (saved: T, previousId: string | undefined) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<StatDraft>(() => draftOf(props.stat));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    let min: number;
    let max: number;
    let defaultValue: number;
    try {
      min = statInteger(value.min, "Min");
      max = statInteger(value.max, "Max");
      defaultValue = statInteger(value.default_value, "Default");
      if (min >= max) throw new Error("Min must be less than max.");
      if (defaultValue < min || defaultValue > max) throw new Error("Default must be between min and max.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Check the stat's scale.");
      return;
    }
    const fields = {
      label: value.label.trim(),
      description: value.description.trim(),
      low_label: value.low_label.trim(),
      high_label: value.high_label.trim(),
      min,
      max,
      default_value: defaultValue,
      color: value.color,
    };
    setSaving(true);
    setSaveError("");
    try {
      const saved = props.stat
        ? await props.onUpdate(props.stat.id, fields)
        : await props.onCreate({ applies_to: value.applies_to, ...fields });
      props.onSaved(saved, props.stat?.id);
      props.onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save this stat.");
    } finally {
      setSaving(false);
    }
  };

  const textInput =
    "min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="backdrop fixed inset-0 z-30 bg-black/40" />
        <DialogPrimitive.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (props.openerRef?.current?.isConnected) props.openerRef.current.focus();
            if (props.openerRef) props.openerRef.current = null;
          }}
          className="fixed inset-0 z-40 flex flex-col bg-surface md:inset-bs-1/2 md:inset-be-auto md:start-1/2 md:max-h-[min(90dvh,52rem)] md:w-[min(calc(100vw-2rem),36rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-xl"
        >
          <form className="flex [min-block-size:0] flex-1 flex-col" onSubmit={submit}>
            <header className="flex-none border-be border-border p-5 md:px-7 md:py-6">
              <DialogPrimitive.Title className="text-xl font-semibold">{props.title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mbs-1 text-sm text-muted">{props.description}</DialogPrimitive.Description>
            </header>
            <div className="chat-scroll min-block-size-0 flex-1 p-5 md:p-7">
              <div className="grid gap-5">
                {!props.stat && (
                  <label className="grid gap-2 text-sm font-medium">
                    Applies to
                    <select
                      value={value.applies_to}
                      onChange={(event) => setValue({ ...value, applies_to: event.target.value as StatKind })}
                      className={`${textInput} cursor-pointer`}
                    >
                      {Object.entries(KIND_LABELS).map(([kind, label]) => (
                        <option key={kind} value={kind}>{label}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="grid gap-2 text-sm font-medium">
                  Label
                  <input
                    required
                    autoComplete="off"
                    value={value.label}
                    onChange={(event) => setValue({ ...value, label: event.target.value })}
                    className={textInput}
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium">
                  Description
                  <textarea
                    required
                    rows={3}
                    value={value.description}
                    onChange={(event) => setValue({ ...value, description: event.target.value })}
                    className="min-h-20 resize-y rounded-lg border border-border bg-background px-3 py-2 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                </label>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-4">
                  <label className="grid gap-2 text-sm font-medium">
                    Low end label
                    <input
                      required
                      autoComplete="off"
                      value={value.low_label}
                      onChange={(event) => setValue({ ...value, low_label: event.target.value })}
                      className={textInput}
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-medium">
                    High end label
                    <input
                      required
                      autoComplete="off"
                      value={value.high_label}
                      onChange={(event) => setValue({ ...value, high_label: event.target.value })}
                      className={textInput}
                    />
                  </label>
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-4">
                  <label className="grid gap-2 text-sm font-medium">
                    Min
                    <input
                      required
                      type="number"
                      value={value.min}
                      onChange={(event) => setValue({ ...value, min: event.target.value })}
                      className={textInput}
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-medium">
                    Max
                    <input
                      required
                      type="number"
                      value={value.max}
                      onChange={(event) => setValue({ ...value, max: event.target.value })}
                      className={textInput}
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-medium">
                    Default
                    <input
                      required
                      type="number"
                      value={value.default_value}
                      onChange={(event) => setValue({ ...value, default_value: event.target.value })}
                      className={textInput}
                    />
                  </label>
                </div>
                <fieldset className="grid gap-2 text-sm font-medium">
                  <legend>Color</legend>
                  <div className="flex flex-wrap gap-2">
                    {STAT_COLORS.map((color) => (
                      <label
                        key={color}
                        title={color}
                        className={`pressable inline-flex cursor-pointer items-center justify-center rounded-full border border-border p-1.5 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised ${
                          value.color === color ? "outline-2 outline-offset-2 outline-accent" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="stat-color"
                          className="sr-only"
                          value={color}
                          checked={value.color === color}
                          onChange={() => setValue({ ...value, color })}
                        />
                        <span className="block size-5 rounded-full" style={{ background: `var(--stat-${color})` }} aria-hidden="true" />
                        <span className="sr-only">{color}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {saveError && <p className="text-sm text-muted" role="alert">{saveError}</p>}
              </div>
            </div>
            <footer className="flex flex-none flex-wrap justify-end gap-2 border-bs border-border p-4 [padding-block-end:calc(1rem+env(safe-area-inset-bottom,0px))] md:p-5">
              <DialogPrimitive.Close asChild>
                <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 py-2 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={saving}>Cancel</button>
              </DialogPrimitive.Close>
              <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>
                {saving ? "Saving…" : props.stat ? "Save changes" : "Add stat"}
              </button>
            </footer>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
