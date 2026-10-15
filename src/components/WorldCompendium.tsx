import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import type { World, WorldCharacter, WorldEntry, WorldEntryKind } from "../../shared/domain";
import {
  createWorldCharacter,
  createWorldEntry,
  deleteWorldCharacter,
  deleteWorldEntry,
  updateWorldCharacterContext,
  updateWorldEntry,
  type WorldEntryInput,
} from "../lib/storyApi";
import {
  applyWorldCharacterRemoved,
  applyWorldCharacterSaved,
  applyWorldEntryRemoved,
  applyWorldEntrySaved,
  ensureWorldCharacters,
  ensureWorldEntries,
  refreshCharacters,
  refreshWorldCharacters,
  refreshWorldEntries,
  useCharacters,
  useWorldCharacters,
  useWorldEntries,
} from "../lib/libraryCache";
import { worldEntryGroups } from "../lib/worldEntryGroups";

type EntryEditor = WorldEntryInput & { id: string | null };
type CastEditor = { mode: "add" | "edit"; characterId: string; context: string };

const ENTRY_LABELS: Record<WorldEntryKind, string> = {
  local_npc: "local NPC",
  location: "location",
  lore: "lore entry",
  scene: "opening scene",
};

export function WorldCompendium(props: { world: World; onClose: () => void }) {
  const entriesLibrary = useWorldEntries(props.world.id);
  const castLibrary = useWorldCharacters(props.world.id);
  const charactersLibrary = useCharacters();
  const [editor, setEditor] = useState<EntryEditor | null>(null);
  const entryOpenerRef = useRef<HTMLElement | null>(null);
  const castOpenerRef = useRef<HTMLElement | null>(null);
  const [castEditor, setCastEditor] = useState<CastEditor | null>(null);
  const [saveError, setSaveError] = useState("");
  const [castSaveError, setCastSaveError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [castSaving, setCastSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletingCharacterId, setDeletingCharacterId] = useState<string | null>(null);
  const entries = useMemo(
    () => [...(entriesLibrary.items ?? [])].sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [entriesLibrary.items],
  );
  const worldCast = useMemo(
    () => [...(castLibrary.items ?? [])].sort((a, b) =>
      a.character.name.localeCompare(b.character.name) || a.character_id.localeCompare(b.character_id)),
    [castLibrary.items],
  );
  const worldCastIds = new Set(worldCast.map(({ character_id }) => character_id));
  const charactersById = new Map((charactersLibrary.items ?? []).map((character) => [character.id, character]));
  const availableCharacters = (charactersLibrary.items ?? []).filter(({ id }) => !worldCastIds.has(id));

  useEffect(() => {
    ensureWorldEntries(props.world.id);
    ensureWorldCharacters(props.world.id);
  }, [props.world.id]);

  const openNew = (kind: WorldEntryKind) => {
    setEditor({ id: null, kind, name: "", description: "" });
    setSaveError("");
    setActionError("");
  };

  const openEdit = (entry: WorldEntry) => {
    setEditor({ id: entry.id, kind: entry.kind, name: entry.name, description: entry.description });
    setSaveError("");
    setActionError("");
  };

  const openAddWorldCharacter = () => {
    setCastEditor({ mode: "add", characterId: "", context: "" });
    setCastSaveError("");
  };

  const openEditWorldCharacter = (association: WorldCharacter) => {
    setCastEditor({ mode: "edit", characterId: association.character_id, context: association.context });
    setCastSaveError("");
  };

  const submitEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    const input = {
      kind: editor.kind,
      name: editor.name.trim(),
      description: editor.description.trim(),
    };
    setSaving(true);
    setSaveError("");
    try {
      const saved = editor.id
        ? await updateWorldEntry(props.world.id, editor.id, input)
        : await createWorldEntry(props.world.id, input);
      applyWorldEntrySaved(props.world.id, saved, editor.id ?? undefined);
      setEditor(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save this entry.");
    } finally {
      setSaving(false);
    }
  };

  const submitWorldCharacter = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!castEditor || castSaving || !castEditor.characterId) return;
    setCastSaving(true);
    setCastSaveError("");
    try {
      const saved = castEditor.mode === "add"
        ? await createWorldCharacter(props.world.id, castEditor.characterId, castEditor.context.trim())
        : await updateWorldCharacterContext(props.world.id, castEditor.characterId, castEditor.context.trim());
      applyWorldCharacterSaved(
        props.world.id,
        saved,
        castEditor.mode === "edit" ? saved.character_id : undefined,
      );
      setCastEditor(null);
    } catch (error) {
      setCastSaveError(error instanceof Error ? error.message : "Could not save this world cast context.");
    } finally {
      setCastSaving(false);
    }
  };

  const removeEntry = async (entry: WorldEntry) => {
    if (!window.confirm(`Delete “${entry.name}” from ${props.world.name}? Campaigns that already include it keep their captured copy.`)) return;
    setDeletingId(entry.id);
    setActionError("");
    try {
      await deleteWorldEntry(props.world.id, entry.id);
      applyWorldEntryRemoved(props.world.id, entry.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not delete this entry.");
    } finally {
      setDeletingId(null);
    }
  };

  const removeWorldCharacter = async (association: WorldCharacter) => {
    if (!window.confirm(`Remove “${association.character.name}” from ${props.world.name}’s cast? The global character remains in your library.`)) return;
    setDeletingCharacterId(association.character_id);
    setActionError("");
    try {
      await deleteWorldCharacter(props.world.id, association.character_id);
      applyWorldCharacterRemoved(props.world.id, association.character_id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not remove this character from the world cast.");
    } finally {
      setDeletingCharacterId(null);
    }
  };

  const loading = entriesLibrary.items === undefined && entriesLibrary.loadError === undefined;
  const selectedCastCharacter = castEditor
    ? charactersById.get(castEditor.characterId) ?? worldCast.find(({ character_id }) => character_id === castEditor.characterId)?.character
    : undefined;

  return (
    <DialogPrimitive.Root
      open={editor !== null}
      onOpenChange={(open) => { if (!open) setEditor(null); }}
    >
      <section
        id={`world-compendium-${props.world.id}`}
        className="mbs-6 mbe-6 grid gap-5 rounded-xl border border-border bg-surface p-5"
        aria-labelledby="world-compendium-title"
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">World compendium</p>
            <h2 id="world-compendium-title" className="mbs-1 text-xl font-semibold">{props.world.name}</h2>
            <p className="mbs-1 text-sm text-muted">Global characters with world-specific context, local NPCs, places, lore, and opening scenes.</p>
          </div>
          <button
            type="button"
            className="pressable inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
            onClick={props.onClose}
          >
            <X className="size-4" aria-hidden="true" />Close
          </button>
        </header>

        {entriesLibrary.refreshError && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
            {entriesLibrary.refreshError}
            <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => refreshWorldEntries(props.world.id)}>Retry</button>
          </p>
        )}
        {actionError && <p className="text-sm text-muted" role="alert">{actionError}</p>}

        <DialogPrimitive.Root
          open={castEditor !== null}
          onOpenChange={(open) => { if (!open) setCastEditor(null); }}
        >
          <section className="grid gap-4 rounded-xl border border-border bg-raised p-5" aria-labelledby="world-cast-title">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Reusable characters</p>
                <h3 id="world-cast-title" className="mbs-1 text-lg font-semibold">World cast</h3>
                <p className="mbs-1 max-w-2xl text-sm leading-6 text-muted">Add global characters to this world and give them context that does not change their shared definition.</p>
              </div>
              <DialogPrimitive.Trigger asChild>
                <button
                  type="button"
                  className="pressable inline-flex min-h-10 flex-none items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                  onClick={(event) => {
                    castOpenerRef.current = event.currentTarget;
                    openAddWorldCharacter();
                  }}
                  disabled={availableCharacters.length === 0}
                >
                  <Plus className="size-4" aria-hidden="true" />Add character
                </button>
              </DialogPrimitive.Trigger>
            </header>

            {castLibrary.refreshError && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                {castLibrary.refreshError}
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => refreshWorldCharacters(props.world.id)}>Retry</button>
              </p>
            )}
            {castLibrary.items === undefined ? (
              castLibrary.loadError ? (
                <section className="grid justify-items-start gap-3 rounded-lg border border-border p-5" role="alert">
                  <p className="text-sm text-muted">{castLibrary.loadError}</p>
                  <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshWorldCharacters(props.world.id)}>Try again</button>
                </section>
              ) : <p className="text-sm text-muted" role="status">Loading this world’s cast…</p>
            ) : worldCast.length === 0 ? (
              <p className="text-sm text-muted">No global characters have been added to this world yet.</p>
            ) : (
              <ul className="grid list-none gap-4 p-0">
                {worldCast.map((association) => {
                  const character = charactersById.get(association.character_id) ?? association.character;
                  return (
                    <li key={association.character_id} className="grid gap-3 border-bs border-border pbs-4 first:border-0 first:pbs-0">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="font-semibold">{character.name}</h4>
                            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">Global character</span>
                          </div>
                          <p className="mbs-1 whitespace-pre-wrap text-sm leading-6 text-muted">{character.description}</p>
                        </div>
                        <div className="flex flex-none items-center gap-1">
                          <DialogPrimitive.Trigger asChild>
                            <button
                              type="button"
                              className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                              aria-label={`Edit ${character.name} world context`}
                              onClick={(event) => {
                                castOpenerRef.current = event.currentTarget;
                                openEditWorldCharacter(association);
                              }}
                              disabled={castSaving || deletingCharacterId !== null}
                            ><Pencil className="size-4" aria-hidden="true" /></button>
                          </DialogPrimitive.Trigger>
                          <button
                            type="button"
                            className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                            aria-label={`Remove ${character.name} from ${props.world.name} cast`}
                            onClick={() => { void removeWorldCharacter(association); }}
                            disabled={castSaving || deletingCharacterId !== null}
                          ><Trash2 className="size-4" aria-hidden="true" /></button>
                        </div>
                      </div>
                      <p className="whitespace-pre-wrap rounded-lg bg-surface p-3 text-sm leading-6 text-muted">
                        <span className="font-medium text-foreground">World-specific context:</span> {association.context || "None yet."}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}

            {charactersLibrary.items === undefined ? (
              charactersLibrary.loadError ? (
                <div className="grid justify-items-start gap-2" role="alert">
                  <p className="text-sm text-muted">{charactersLibrary.loadError}</p>
                  <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshCharacters()}>Try again</button>
                </div>
              ) : <p className="text-sm text-muted" role="status">Loading the global character library…</p>
            ) : charactersLibrary.items.length === 0 ? (
              <p className="text-sm text-muted">Create a global character before adding someone to this world. <Link className="font-medium text-accent underline underline-offset-2" to="/characters">Open Characters</Link></p>
            ) : availableCharacters.length === 0 ? (
              <p className="text-sm text-muted">All global characters are already in this world’s cast. <Link className="font-medium text-accent underline underline-offset-2" to="/characters">Create another character</Link></p>
            ) : null}
          </section>

          {castEditor && (
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="backdrop fixed inset-0 z-30 bg-black/40" />
              <DialogPrimitive.Content
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (castOpenerRef.current?.isConnected) castOpenerRef.current.focus();
                  castOpenerRef.current = null;
                }}
                className="fixed inset-0 z-40 flex flex-col bg-surface md:inset-bs-1/2 md:inset-be-auto md:start-1/2 md:max-h-[min(90dvh,48rem)] md:w-[min(calc(100vw-2rem),56rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-xl"
              >
                <form className="flex [min-block-size:0] flex-1 flex-col" onSubmit={submitWorldCharacter}>
                  <header className="flex-none border-be border-border p-5 md:px-7 md:py-6">
                    <DialogPrimitive.Title className="text-xl font-semibold">
                      {castEditor.mode === "add" ? "Add character to world cast" : `Edit ${selectedCastCharacter?.name ?? "character"} in this world`}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="mbs-1 text-sm text-muted">The character definition stays global; these notes apply only to {props.world.name}.</DialogPrimitive.Description>
                  </header>
                  <div className="chat-scroll min-block-size-0 flex-1 p-5 md:p-7">
                    <div className="grid gap-6">
                      {castEditor.mode === "add" ? (
                        <label className="grid gap-2 text-sm font-medium">
                          Global character
                          <select
                            required
                            value={castEditor.characterId}
                            onChange={(event) => setCastEditor({ ...castEditor, characterId: event.target.value })}
                            className="min-h-11 rounded-lg border border-border bg-background px-3 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            <option value="" disabled>Choose a character</option>
                            {availableCharacters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
                          </select>
                        </label>
                      ) : (
                        <div className="grid gap-1 rounded-lg border border-border bg-background p-4">
                          <p className="text-sm font-medium">Global character</p>
                          <p className="text-lg font-semibold">{selectedCastCharacter?.name}</p>
                          <p className="text-sm text-muted">The character remains reusable in every world.</p>
                        </div>
                      )}
                      <label className="grid gap-2 text-sm font-medium">
                        World-specific context <span className="font-normal text-muted">Optional</span>
                        <textarea
                          rows={10}
                          value={castEditor.context}
                          onChange={(event) => setCastEditor({ ...castEditor, context: event.target.value })}
                          placeholder="How this character fits into this world, their local role, or what they know here."
                          className="min-h-64 resize-y rounded-lg border border-border bg-background px-3 py-3 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        />
                      </label>
                      {castSaveError && <p className="text-sm text-muted" role="alert">{castSaveError}</p>}
                    </div>
                  </div>
                  <footer className="flex flex-none flex-wrap justify-end gap-2 border-bs border-border p-4 [padding-block-end:calc(1rem+env(safe-area-inset-bottom,0px))] md:p-5">
                    <DialogPrimitive.Close asChild>
                      <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 py-2 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={castSaving}>Cancel</button>
                    </DialogPrimitive.Close>
                    <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={castSaving || (castEditor.mode === "add" && !availableCharacters.length)}>
                      {castSaving ? "Saving…" : castEditor.mode === "add" ? "Add to world cast" : "Save context"}
                    </button>
                  </footer>
                </form>
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          )}
        </DialogPrimitive.Root>

        {loading ? (
          <p className="py-4 text-sm text-muted" role="status">Loading compendium…</p>
        ) : entriesLibrary.loadError ? (
          <section className="grid justify-items-start gap-3 rounded-lg border border-border p-5" role="alert">
            <p className="text-sm text-muted">{entriesLibrary.loadError}</p>
            <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => refreshWorldEntries(props.world.id)}>Try again</button>
          </section>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-4">
            {worldEntryGroups.map((group) => {
              const groupedEntries = entries.filter((entry) => entry.kind === group.kind);
              return (
                <section key={group.kind} className="grid content-start gap-3 rounded-lg border border-border bg-raised p-4" aria-labelledby={`world-entry-${group.kind}-title`}>
                  <header className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 id={`world-entry-${group.kind}-title`} className="font-semibold">{group.label}</h3>
                      <p className="text-xs text-muted">{groupedEntries.length} {groupedEntries.length === 1 ? "entry" : "entries"}</p>
                    </div>
                    <DialogPrimitive.Trigger asChild>
                      <button
                        type="button"
                        className="pressable inline-flex min-h-10 flex-none items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                        onClick={(event) => {
                          entryOpenerRef.current = event.currentTarget;
                          openNew(group.kind);
                        }}
                        aria-label={`Add ${ENTRY_LABELS[group.kind]}`}
                      ><Plus className="size-4" aria-hidden="true" />{group.kind === "scene" ? "Add" : `Add ${ENTRY_LABELS[group.kind]}`}</button>
                    </DialogPrimitive.Trigger>
                  </header>

                  {groupedEntries.length === 0 ? (
                    <p className="text-sm text-muted">No {group.label.toLocaleLowerCase()} yet.</p>
                  ) : (
                    <ul className="grid list-none gap-3 p-0">
                      {groupedEntries.map((entry) => (
                        <li key={entry.id} className="grid gap-2 border-bs border-border pbs-3 first:border-0 first:pbs-0">
                          <div className="flex items-start justify-between gap-2">
                            <h4 className="font-medium leading-snug">{entry.name}</h4>
                            <div className="flex flex-none items-center gap-1">
                              <DialogPrimitive.Trigger asChild>
                                <button
                                  type="button"
                                  className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                                  aria-label={`Edit ${entry.name}`}
                                  onClick={(event) => {
                                    entryOpenerRef.current = event.currentTarget;
                                    openEdit(entry);
                                  }}
                                  disabled={saving || deletingId !== null}
                                ><Pencil className="size-4" aria-hidden="true" /></button>
                              </DialogPrimitive.Trigger>
                              <button
                                type="button"
                                className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                                aria-label={`Delete ${entry.name}`}
                                onClick={() => { void removeEntry(entry); }}
                                disabled={saving || deletingId !== null}
                              ><Trash2 className="size-4" aria-hidden="true" /></button>
                            </div>
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{entry.description}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </section>

      {editor && (
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="backdrop fixed inset-0 z-30 bg-black/40" />
          <DialogPrimitive.Content
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (entryOpenerRef.current?.isConnected) entryOpenerRef.current.focus();
              entryOpenerRef.current = null;
            }}
            className="fixed inset-0 z-40 flex flex-col bg-surface md:inset-bs-1/2 md:inset-be-auto md:start-1/2 md:max-h-[min(90dvh,48rem)] md:w-[min(calc(100vw-2rem),56rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-xl"
          >
            <form className="flex [min-block-size:0] flex-1 flex-col" onSubmit={submitEntry}>
              <header className="flex-none border-be border-border p-5 md:px-7 md:py-6">
                <DialogPrimitive.Title className="text-xl font-semibold">
                  {editor.id ? `Edit ${ENTRY_LABELS[editor.kind]}` : `Add ${ENTRY_LABELS[editor.kind]}`}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mbs-1 text-sm text-muted">Add details to {props.world.name}.</DialogPrimitive.Description>
              </header>
              <div className="chat-scroll min-block-size-0 flex-1 p-5 md:p-7">
                <div className="grid gap-6">
                  <label className="grid gap-2 text-sm font-medium">
                    Name
                    <input
                      required
                      autoComplete="off"
                      value={editor.name}
                      onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                      className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-medium">
                    Description
                    <textarea
                      required
                      rows={10}
                      value={editor.description}
                      onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                      className="min-h-64 resize-y rounded-lg border border-border bg-background px-3 py-3 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                  </label>
                  {saveError && <p className="text-sm text-muted" role="alert">{saveError}</p>}
                </div>
              </div>
              <footer className="flex flex-none flex-wrap justify-end gap-2 border-bs border-border p-4 [padding-block-end:calc(1rem+env(safe-area-inset-bottom,0px))] md:p-5">
                <DialogPrimitive.Close asChild>
                  <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 py-2 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={saving}>Cancel</button>
                </DialogPrimitive.Close>
                <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>
                  {saving ? "Saving…" : editor.id ? "Save changes" : `Add ${ENTRY_LABELS[editor.kind]}`}
                </button>
              </footer>
            </form>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  );
}
