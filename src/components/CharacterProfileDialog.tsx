import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useId, useState, type FormEvent, type RefObject } from "react";
import type { CharacterContextMode, CharacterProfile } from "../../shared/domain";
import { CHARACTER_PROFILE_FIELDS } from "../../shared/domain";
import { AVATAR_ACCEPTED_TYPES, AVATAR_MAX_BYTES, type CharacterCreateInput, type CharacterInput, type CharacterPatch, type CharacterSceneFields } from "../lib/storyApi";
import { Avatar } from "./Avatar";

const optionalFields = CHARACTER_PROFILE_FIELDS.filter(({ required }) => !required);

function emptyProfileInput(): CharacterInput {
  return Object.fromEntries(CHARACTER_PROFILE_FIELDS.map(({ key }) => [key, ""])) as CharacterInput;
}

function profileInputOf(character: CharacterProfile): CharacterInput {
  return Object.fromEntries(CHARACTER_PROFILE_FIELDS.map(({ key }) => [key, character[key]])) as CharacterInput;
}

const contextModes: { value: CharacterContextMode; label: string; help: string }[] = [
  { value: "always", label: "Always", help: "The full profile goes to the narrator every turn." },
  { value: "in_scene", label: "In scene", help: "Only the summary is sent while offstage; the full profile joins when they're named." },
  { value: "mentioned", label: "Only when mentioned", help: "Nothing is sent until their name or a nickname comes up." },
];

const fieldClass = "min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The one character form: every profile field plus picture upload. Callers
 * supply their own save callbacks; this component only owns the form state
 * and error handling.
 */
export function CharacterProfileDialog<T extends CharacterProfile & CharacterSceneFields & { id: string; avatar_id: string | null }>(props: {
  character: T | null;
  /** Prefills the name of a new character. */
  initialName?: string;
  /** Shows the narrator-context controls; hidden for the player's own character. */
  sceneContext?: boolean;
  title: string;
  description: string;
  openerRef?: RefObject<HTMLElement | null>;
  onCreate: (input: CharacterCreateInput) => Promise<T>;
  onUpdate: (id: string, input: CharacterPatch) => Promise<T>;
  onAvatarUpload: (id: string, file: File) => Promise<T>;
  onAvatarRemove: (id: string) => Promise<T>;
  onSaved: (saved: T, previousId: string | undefined) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<CharacterInput>(() =>
    props.character ? profileInputOf(props.character) : { ...emptyProfileInput(), name: props.initialName ?? "" });
  const [avatarId, setAvatarId] = useState(props.character?.avatar_id ?? null);
  const [saving, setSaving] = useState(false);
  const [contextMode, setContextMode] = useState<CharacterContextMode>(props.character?.context_mode ?? "in_scene");
  const [summary, setSummary] = useState(props.character?.summary ?? "");
  const [aliases, setAliases] = useState((props.character?.aliases ?? []).join(", "));
  const [sticky, setSticky] = useState(String(props.character?.sticky ?? 4));
  const modeId = useId();
  const summaryId = useId();
  const aliasesId = useId();
  const stickyId = useId();
  const [saveError, setSaveError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  const pickAvatar = async (file: File | undefined) => {
    if (!props.character?.id || avatarBusy) return;
    setAvatarError("");
    if (!file) return;
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError("Pictures are limited to 2 MiB.");
      return;
    }
    if (file.type && !AVATAR_ACCEPTED_TYPES.split(",").includes(file.type)) {
      setAvatarError("Use a PNG, JPEG, WebP, or GIF picture.");
      return;
    }
    setAvatarBusy(true);
    try {
      const saved = await props.onAvatarUpload(props.character.id, file);
      props.onSaved(saved, props.character.id);
      setAvatarId(saved.avatar_id);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "Could not upload this picture.");
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    if (!props.character?.id || avatarBusy) return;
    setAvatarError("");
    setAvatarBusy(true);
    try {
      const saved = await props.onAvatarRemove(props.character.id);
      props.onSaved(saved, props.character.id);
      setAvatarId(saved.avatar_id);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "Could not remove this picture.");
    } finally {
      setAvatarBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const input: CharacterCreateInput = {
      name: value.name.trim(),
      description: value.description.trim(),
      appearance: value.appearance?.trim() ?? "",
      personality: value.personality?.trim() ?? "",
      background: value.background?.trim() ?? "",
      baseline_motivations: value.baseline_motivations?.trim() ?? "",
      speaking_style: value.speaking_style?.trim() ?? "",
      knowledge: value.knowledge?.trim() ?? "",
      ...(props.sceneContext && {
        context_mode: contextMode,
        summary: summary.trim(),
        aliases: aliases.split(",").map((alias) => alias.trim()).filter(Boolean),
        sticky: Number(sticky),
      }),
    };
    setSaving(true);
    setSaveError("");
    try {
      const saved = props.character
        ? await props.onUpdate(props.character.id, input)
        : await props.onCreate(input);
      props.onSaved(saved, props.character?.id);
      props.onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save this character.");
    } finally {
      setSaving(false);
    }
  };

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
          className="fixed inset-0 z-40 flex flex-col bg-surface md:inset-bs-1/2 md:inset-be-auto md:start-1/2 md:max-h-[min(90dvh,52rem)] md:w-[min(calc(100vw-2rem),58rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-xl"
        >
          <form className="flex [min-block-size:0] flex-1 flex-col" onSubmit={submit}>
            <header className="flex-none border-be border-border p-5 md:px-7 md:py-6">
              <DialogPrimitive.Title className="text-xl font-semibold">{props.title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mbs-1 text-sm text-muted">{props.description}</DialogPrimitive.Description>
            </header>
            <div className="chat-scroll min-block-size-0 flex-1 p-5 md:p-7">
              <div className="grid gap-6">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] gap-5">
                  <label className="grid content-start gap-2 text-sm font-medium">
                    Name
                    <input required autoComplete="off" value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
                  </label>
                  <label className="grid content-start gap-2 text-sm font-medium">
                    Description
                    <textarea required rows={5} value={value.description} onChange={(event) => setValue({ ...value, description: event.target.value })} className="min-h-32 resize-y rounded-lg border border-border bg-background px-3 py-3 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
                  </label>
                </div>
                {props.character && (
                  <div className="flex flex-wrap items-center gap-4">
                    <Avatar name={value.name} imageId={avatarId} className="size-16 text-xl" />
                    <div className="grid content-start gap-2">
                      <div className="flex flex-wrap gap-2">
                        <label className="pressable inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface">
                          Upload picture
                          <input
                            type="file"
                            accept={AVATAR_ACCEPTED_TYPES}
                            disabled={avatarBusy}
                            className="sr-only"
                            onChange={(event) => {
                              void pickAvatar(event.target.files?.[0]);
                              event.target.value = "";
                            }}
                          />
                        </label>
                        {avatarId && (
                          <button
                            type="button"
                            disabled={avatarBusy}
                            className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                            onClick={() => void removeAvatar()}
                          >
                            Remove picture
                          </button>
                        )}
                      </div>
                      {avatarError && <p className="text-sm text-muted" role="alert">{avatarError}</p>}
                    </div>
                  </div>
                )}
                {optionalFields.map(({ key, label }) => (
                  <label key={key} className="grid gap-2 text-sm font-medium">
                    {label} <span className="font-normal text-muted">Optional</span>
                    <textarea rows={4} value={value[key] ?? ""} onChange={(event) => setValue({ ...value, [key]: event.target.value })} className="min-h-28 resize-y rounded-lg border border-border bg-background px-3 py-3 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
                  </label>
                ))}
                {props.sceneContext && (
                  <div className="grid gap-5 border-bs border-border pbs-6">
                    <div className="grid content-start gap-2">
                      <label htmlFor={modeId} className="text-sm font-medium">Sent to the narrator</label>
                      <select id={modeId} aria-describedby={`${modeId}-help`} value={contextMode} onChange={(event) => setContextMode(event.target.value as CharacterContextMode)} className={fieldClass}>
                        {contextModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                      </select>
                      <p id={`${modeId}-help`} className="text-sm text-muted">{contextModes.find((mode) => mode.value === contextMode)?.help}</p>
                    </div>
                    {contextMode === "in_scene" && (
                      <div className="grid content-start gap-2">
                        <label htmlFor={summaryId} className="text-sm font-medium">One-line summary</label>
                        <input id={summaryId} aria-describedby={`${summaryId}-help`} autoComplete="off" maxLength={200} value={summary} onChange={(event) => setSummary(event.target.value)} className={fieldClass} />
                        <p id={`${summaryId}-help`} className="text-sm text-muted">Sent every turn while they are offstage. Who they are and what you'd notice first.</p>
                      </div>
                    )}
                    {contextMode !== "always" && (
                      <>
                        <div className="grid content-start gap-2">
                          <label htmlFor={aliasesId} className="text-sm font-medium">Nicknames</label>
                          <input id={aliasesId} aria-describedby={`${aliasesId}-help`} autoComplete="off" value={aliases} onChange={(event) => setAliases(event.target.value)} className={fieldClass} />
                          <p id={`${aliasesId}-help`} className="text-sm text-muted">Comma-separated. Any of these also brings them into the scene.</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          <label htmlFor={stickyId}>Stays active for</label>
                          <input id={stickyId} type="number" required min={0} max={50} step={1} inputMode="numeric" value={sticky} onChange={(event) => setSticky(event.target.value)} className={`${fieldClass} w-24`} />
                          <span aria-hidden="true">more messages</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {saveError && <p className="text-sm text-muted" role="alert">{saveError}</p>}
              </div>
            </div>
            <footer className="flex flex-none flex-wrap justify-end gap-2 border-bs border-border p-4 [padding-block-end:calc(1rem+env(safe-area-inset-bottom,0px))] md:p-5">
              <DialogPrimitive.Close asChild>
                <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 py-2 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={saving}>Cancel</button>
              </DialogPrimitive.Close>
              <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>
                {saving ? "Saving…" : props.character ? "Save changes" : "Create character"}
              </button>
            </footer>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
