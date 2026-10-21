import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Pencil, Plus, Search, UserRound } from "lucide-react";
import type { Character } from "../../shared/domain";
import {
  AVATAR_ACCEPTED_TYPES,
  AVATAR_MAX_BYTES,
  createCharacter,
  deleteCharacterAvatar,
  updateCharacter,
  uploadCharacterAvatar,
  type CharacterInput,
} from "../lib/storyApi";
import { charactersLibrary, refreshCharacters, useCharacters } from "../lib/libraryCache";
import { AppHeader } from "./AppHeader";
import { Avatar } from "./Avatar";

const emptyCharacter: CharacterInput = {
  name: "",
  description: "",
  appearance: "",
  personality: "",
  background: "",
  baseline_motivations: "",
  speaking_style: "",
};

const detailFields = [
  { name: "appearance", label: "Appearance" },
  { name: "personality", label: "Personality" },
  { name: "background", label: "Background" },
  { name: "baseline_motivations", label: "Baseline motivations" },
  { name: "speaking_style", label: "Speaking style" },
] as const;

export function CharactersPage(props: {
  onOpenSidebar: () => void;
  onSelect: (character: Character) => void;
}) {
  const library = useCharacters();
  const characters = library.items;
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ id: string | null; avatarId: string | null; value: CharacterInput } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const editorOpenerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    refreshCharacters();
  }, []);

  const coldLoading = characters === undefined && library.loadError === undefined;
  useEffect(() => {
    if (!coldLoading) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), 200);
    return () => window.clearTimeout(timer);
  }, [coldLoading]);

  const visibleCharacters = useMemo(() => {
    const current = characters ?? [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return current;
    return current.filter((character) =>
      [character.name, character.description, ...detailFields.map(({ name }) => character[name])]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [characters, query]);

  const openNew = () => {
    setEditor({ id: null, avatarId: null, value: { ...emptyCharacter } });
    setSaveError("");
    setAvatarError("");
  };

  const openEdit = (character: Character) => {
    setEditor({
      id: character.id,
      avatarId: character.avatar_id,
      value: {
        name: character.name,
        description: character.description,
        appearance: character.appearance,
        personality: character.personality,
        background: character.background,
        baseline_motivations: character.baseline_motivations,
        speaking_style: character.speaking_style,
      },
    });
    setSaveError("");
    setAvatarError("");
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!editor?.id || avatarBusy) return;
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
      const saved = await uploadCharacterAvatar(editor.id, file);
      charactersLibrary.applySaved(saved, editor.id);
      setEditor((current) => (current?.id === editor.id ? { ...current, avatarId: saved.avatar_id } : current));
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "Could not upload this picture.");
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    if (!editor?.id || avatarBusy) return;
    setAvatarError("");
    setAvatarBusy(true);
    try {
      const saved = await deleteCharacterAvatar(editor.id);
      charactersLibrary.applySaved(saved, editor.id);
      setEditor((current) => (current?.id === editor.id ? { ...current, avatarId: saved.avatar_id } : current));
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "Could not remove this picture.");
    } finally {
      setAvatarBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    const input: CharacterInput = {
      name: editor.value.name.trim(),
      description: editor.value.description.trim(),
      appearance: editor.value.appearance?.trim() ?? "",
      personality: editor.value.personality?.trim() ?? "",
      background: editor.value.background?.trim() ?? "",
      baseline_motivations: editor.value.baseline_motivations?.trim() ?? "",
      speaking_style: editor.value.speaking_style?.trim() ?? "",
    };
    setSaving(true);
    setSaveError("");
    try {
      const saved = editor.id
        ? await updateCharacter(editor.id, input)
        : await createCharacter(input);
      charactersLibrary.applySaved(saved, editor.id ?? undefined);
      setEditor(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save this character.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogPrimitive.Root
      open={editor !== null}
      onOpenChange={(open) => { if (!open) setEditor(null); }}
    >
      <div className="flex min-inline-size-0 flex-1 flex-col">
        <AppHeader title="Characters" onOpenSidebar={props.onOpenSidebar} />
        <div className="chat-scroll min-block-size-0 flex-1">
          <main className="mx-auto w-full max-w-5xl [padding-inline:clamp(1rem,0.75rem+1vw,2rem)] [padding-block:clamp(1.5rem,1.25rem+1vw,2rem)]">
            <header className="mbe-6 flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Your library</p>
                <h1 className="mbs-2 text-3xl font-semibold tracking-tight">Characters</h1>
                <p className="mbs-2 text-sm leading-6 text-muted">
                  Reusable characters for stories. Worlds can add their own context without changing a character’s shared definition.
                </p>
              </div>
              <DialogPrimitive.Trigger asChild>
                <button
                  type="button"
                  className="pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90"
                  onClick={(event) => {
                    editorOpenerRef.current = event.currentTarget;
                    openNew();
                  }}
                >
                  <Plus className="size-4" aria-hidden="true" />Create character
                </button>
              </DialogPrimitive.Trigger>
            </header>

            <div className="mbe-5 flex flex-wrap items-center gap-3">
              <label className="flex min-h-11 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-raised px-3 text-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
                <Search className="size-4 shrink-0" aria-hidden="true" />
                <span className="sr-only">Search characters</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search characters"
                  className="min-w-0 flex-1 bg-transparent py-2 text-base text-foreground outline-hidden placeholder:text-muted/70"
                />
              </label>
              {characters !== undefined && <p className="text-sm text-muted" role="status">{visibleCharacters.length} {visibleCharacters.length === 1 ? "character" : "characters"}</p>}
              {characters !== undefined && library.refreshError && (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                  {library.refreshError}
                  <button
                    type="button"
                    className="pressable min-h-11 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                    onClick={() => refreshCharacters()}
                  >
                    Retry
                  </button>
                </p>
              )}
            </div>

            {coldLoading ? (
              <div className="[min-block-size:14rem]">
                <p className="sr-only" role="status">Loading characters…</p>
                {showSkeleton && (
                  <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4 p-0" aria-hidden="true">
                    {[0, 1, 2, 3].map((key) => (
                      <li key={key}>
                        <div className="flex h-full flex-col gap-4 rounded-xl border border-border bg-raised p-5 motion-safe:animate-pulse">
                          <div className="flex items-start gap-3">
                            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-muted" />
                            <div className="min-w-0 flex-1">
                              <div className="h-5 w-1/2 rounded bg-muted" />
                              <div className="mbs-3 h-4 w-full rounded bg-muted" />
                              <div className="mbs-2 h-4 w-5/6 rounded bg-muted" />
                              <div className="mbs-2 h-4 w-2/3 rounded bg-muted" />
                            </div>
                          </div>
                          <div className="[margin-block-start:auto] flex gap-2 border-bs border-border pbs-3">
                            <div className="min-h-10 flex-1 rounded-lg bg-muted" />
                            <div className="min-h-10 flex-1 rounded-lg bg-muted" />
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : characters === undefined ? (
              <section className="grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
                <p className="text-sm text-muted">{library.loadError}</p>
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => refreshCharacters()}>Try again</button>
              </section>
            ) : visibleCharacters.length === 0 ? (
              <section className="grid justify-items-center gap-3 rounded-xl border border-dashed border-border px-5 py-12 text-center">
                <UserRound className="size-6 text-muted" aria-hidden="true" />
                <h2 className="font-semibold">{characters.length ? "No characters match your search" : "Your character library is empty"}</h2>
                <p className="max-w-md text-sm text-muted">{characters.length ? "Try another name or part of a character’s description." : "Create a character to bring into any world or campaign."}</p>
                {characters.length === 0 && (
                  <DialogPrimitive.Trigger asChild>
                    <button type="button" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg" onClick={(event) => {
                      editorOpenerRef.current = event.currentTarget;
                      openNew();
                    }}>Create character</button>
                  </DialogPrimitive.Trigger>
                )}
                {characters.length > 0 && <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setQuery("")}>Clear search</button>}
              </section>
            ) : (
              <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4 p-0">
                {visibleCharacters.map((character) => (
                  <li key={character.id}>
                    <article className="flex h-full flex-col gap-4 rounded-xl border border-border bg-raised p-5">
                      <div className="flex items-start gap-3">
                        <Avatar name={character.name} imageId={character.avatar_id} className="size-11 text-base" />
                        <div className="min-w-0 flex-1">
                          <h2 className="text-lg font-semibold leading-snug">{character.name}</h2>
                          <p className="mbs-2 line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-muted">{character.description}</p>
                          {detailFields.filter(({ name }) => character[name]).map(({ name, label }) => (
                            <p key={name} className="mbs-2 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted">
                              <span className="font-medium text-foreground">{label}:</span> {character[name]}
                            </p>
                          ))}
                        </div>
                      </div>
                      <div className="[margin-block-start:auto] flex flex-wrap gap-2 border-bs border-border pbs-3">
                        <DialogPrimitive.Trigger asChild>
                          <button type="button" className="pressable inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={(event) => {
                            editorOpenerRef.current = event.currentTarget;
                            openEdit(character);
                          }}>
                            <Pencil className="size-4" aria-hidden="true" />Edit
                          </button>
                        </DialogPrimitive.Trigger>
                        <button type="button" className="pressable min-h-10 flex-1 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" onClick={() => props.onSelect(character)}>
                          Use as protagonist
                        </button>
                      </div>
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </main>
        </div>
      </div>

      {editor && (
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="backdrop fixed inset-0 z-30 bg-black/40" />
          <DialogPrimitive.Content
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (editorOpenerRef.current?.isConnected) editorOpenerRef.current.focus();
              editorOpenerRef.current = null;
            }}
            className="fixed inset-0 z-40 flex flex-col bg-surface md:inset-bs-1/2 md:inset-be-auto md:start-1/2 md:max-h-[min(90dvh,52rem)] md:w-[min(calc(100vw-2rem),58rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-xl"
          >
            <form className="flex [min-block-size:0] flex-1 flex-col" onSubmit={submit}>
              <header className="flex-none border-be border-border p-5 md:px-7 md:py-6">
                <DialogPrimitive.Title className="text-xl font-semibold">{editor.id ? "Edit character" : "Create a character"}</DialogPrimitive.Title>
                <DialogPrimitive.Description className="mbs-1 text-sm text-muted">Build a reusable character definition. Add world-specific notes in a world’s cast.</DialogPrimitive.Description>
              </header>
              <div className="chat-scroll min-block-size-0 flex-1 p-5 md:p-7">
                <div className="grid gap-6">
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] gap-5">
                    <label className="grid content-start gap-2 text-sm font-medium">
                      Name
                      <input required autoComplete="off" value={editor.value.name} onChange={(event) => setEditor({ ...editor, value: { ...editor.value, name: event.target.value } })} className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
                    </label>
                    <label className="grid content-start gap-2 text-sm font-medium">
                      Description
                      <textarea required rows={5} value={editor.value.description} onChange={(event) => setEditor({ ...editor, value: { ...editor.value, description: event.target.value } })} className="min-h-32 resize-y rounded-lg border border-border bg-background px-3 py-3 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
                    </label>
                  </div>
                  {editor.id !== null && (
                    <div className="flex flex-wrap items-center gap-4">
                      <Avatar name={editor.value.name} imageId={editor.avatarId} className="size-16 text-xl" />
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
                          {editor.avatarId && (
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
                  {detailFields.map(({ name, label }) => (
                    <label key={name} className="grid gap-2 text-sm font-medium">
                      {label} <span className="font-normal text-muted">Optional</span>
                      <textarea rows={4} value={editor.value[name] ?? ""} onChange={(event) => setEditor({ ...editor, value: { ...editor.value, [name]: event.target.value } })} className="min-h-28 resize-y rounded-lg border border-border bg-background px-3 py-3 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
                    </label>
                  ))}
                  {saveError && <p className="text-sm text-muted" role="alert">{saveError}</p>}
                </div>
              </div>
              <footer className="flex flex-none flex-wrap justify-end gap-2 border-bs border-border p-4 [padding-block-end:calc(1rem+env(safe-area-inset-bottom,0px))] md:p-5">
                <DialogPrimitive.Close asChild>
                  <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 py-2 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={saving}>Cancel</button>
                </DialogPrimitive.Close>
                <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>
                  {saving ? "Saving…" : editor.id ? "Save changes" : "Create character"}
                </button>
              </footer>
            </form>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  );
}
