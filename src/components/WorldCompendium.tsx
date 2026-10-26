import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Copy, KeyRound, Pencil, Plus, Trash2, X } from "lucide-react";
import type { Character, StatDefinition, World, WorldEntry, WorldEntryKind } from "../../shared/domain";
import {
  copyCharacterToLibrary,
  createWorldCharacter,
  createWorldEntry,
  createWorldStat,
  deleteCharacter,
  deleteCharacterAvatar,
  deleteStat,
  deleteWorldEntry,
  updateCharacter,
  updateStat,
  updateWorldEntry,
  uploadCharacterAvatar,
  type WorldEntryInput,
} from "../lib/storyApi";
import {
  applyWorldCharacterRemoved,
  applyWorldCharacterSaved,
  applyWorldEntryRemoved,
  applyWorldEntrySaved,
  applyWorldStatRemoved,
  applyWorldStatSaved,
  ensureWorldCharacters,
  ensureWorldEntries,
  ensureWorldStats,
  refreshCharacters,
  refreshWorldCharacters,
  refreshWorldEntries,
  refreshWorldStats,
  useWorldCharacters,
  useWorldEntries,
  useWorldStats,
} from "../lib/libraryCache";
import { keepEscapeInFindPanel, TextEditor } from "./TextEditor";
import { worldEntryGroups } from "../lib/worldEntryGroups";
import { Avatar } from "./Avatar";
import { CharacterProfileDialog } from "./CharacterProfileDialog";
import { StatDefinitionEditor } from "./StatDefinitionEditor";
import { StatDefinitionList } from "./StatDefinitionList";

type EntryEditor = Pick<WorldEntryInput, "kind" | "name" | "description"> & {
  id: string | null;
  keywords: string;
  priority: string;
  sticky: string;
};

const ENTRY_LABELS: Record<WorldEntryKind, string> = {
  location: "location",
  lore: "lore entry",
  scene: "opening scene",
};

export function WorldCompendium(props: { world: World; onClose: () => void }) {
  const entriesLibrary = useWorldEntries(props.world.id);
  const charactersLibrary = useWorldCharacters(props.world.id);
  const [editor, setEditor] = useState<EntryEditor | null>(null);
  const entryOpenerRef = useRef<HTMLElement | null>(null);
  const characterOpenerRef = useRef<HTMLElement | null>(null);
  const [characterEditor, setCharacterEditor] = useState<{ character: Character | null } | null>(null);
  const [statEditor, setStatEditor] = useState<{ stat: StatDefinition | null } | null>(null);
  const statOpenerRef = useRef<HTMLElement | null>(null);
  const [saveError, setSaveError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyCharacterId, setBusyCharacterId] = useState<string | null>(null);
  const [deletingStatId, setDeletingStatId] = useState<string | null>(null);
  const entries = useMemo(
    () => [...(entriesLibrary.items ?? [])].sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [entriesLibrary.items],
  );
  const worldCharacters = useMemo(
    () => [...(charactersLibrary.items ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [charactersLibrary.items],
  );
  const statsLibrary = useWorldStats(props.world.id);
  const worldStats = statsLibrary.items ?? [];

  useEffect(() => {
    ensureWorldEntries(props.world.id);
    ensureWorldCharacters(props.world.id);
    ensureWorldStats(props.world.id);
  }, [props.world.id]);

  const removeStat = async (stat: StatDefinition) => {
    if (!window.confirm(`Delete “${stat.label}” from ${props.world.name}? Campaigns that already use it keep their copy.`)) return;
    setDeletingStatId(stat.id);
    setActionError("");
    try {
      await deleteStat(stat.id);
      applyWorldStatRemoved(props.world.id, stat.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not delete this stat.");
    } finally {
      setDeletingStatId(null);
    }
  };

  const openNew = (kind: WorldEntryKind) => {
    setEditor({ id: null, kind, name: "", description: "", keywords: "", priority: "0", sticky: "0" });
    setSaveError("");
    setActionError("");
  };

  const openEdit = (entry: WorldEntry) => {
    setEditor({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      keywords: entry.keywords.join(", "),
      priority: String(entry.priority),
      sticky: String(entry.sticky),
    });
    setSaveError("");
    setActionError("");
  };

  const submitEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    const input: WorldEntryInput = {
      kind: editor.kind,
      name: editor.name.trim(),
      description: editor.description.trim(),
    };
    if (editor.kind !== "scene") {
      input.keywords = editor.keywords.split(",").map((keyword) => keyword.trim()).filter(Boolean);
      input.priority = Number(editor.priority);
      input.sticky = Number(editor.sticky);
    }
    if (!input.description) {
      setSaveError("Add a description.");
      return;
    }
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

  const removeWorldCharacter = async (character: Character) => {
    if (!window.confirm(`Delete “${character.name}” from ${props.world.name}? Campaigns that already include this character keep their copy.`)) return;
    setBusyCharacterId(character.id);
    setActionError("");
    try {
      await deleteCharacter(character.id);
      applyWorldCharacterRemoved(props.world.id, character.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not delete this character.");
    } finally {
      setBusyCharacterId(null);
    }
  };

  const copyCharacter = async (character: Character) => {
    if (!window.confirm(`Copy “${character.name}” to your library? Library characters can't be deleted.`)) return;
    setBusyCharacterId(character.id);
    setActionError("");
    try {
      await copyCharacterToLibrary(character.id);
      refreshCharacters();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not copy this character to your library.");
    } finally {
      setBusyCharacterId(null);
    }
  };

  const loading = entriesLibrary.items === undefined && entriesLibrary.loadError === undefined;

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
            <p className="mbs-1 text-sm text-muted">This world’s characters, places, lore, and opening scenes.</p>
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

        <section className="grid gap-4 rounded-xl border border-border bg-raised p-5" aria-labelledby="world-characters-title">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Reusable characters</p>
              <h3 id="world-characters-title" className="mbs-1 text-lg font-semibold">World characters</h3>
              <p className="mbs-1 max-w-2xl text-sm leading-6 text-muted">Characters that belong to {props.world.name}. New campaigns can cast them alongside your library characters.</p>
            </div>
            <button
              type="button"
              className="pressable inline-flex min-h-10 flex-none items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
              onClick={(event) => {
                characterOpenerRef.current = event.currentTarget;
                setCharacterEditor({ character: null });
              }}
            >
              <Plus className="size-4" aria-hidden="true" />Create character
            </button>
          </header>

          {charactersLibrary.refreshError && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
              {charactersLibrary.refreshError}
              <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => refreshWorldCharacters(props.world.id)}>Retry</button>
            </p>
          )}
          {charactersLibrary.items === undefined ? (
            charactersLibrary.loadError ? (
              <section className="grid justify-items-start gap-3 rounded-lg border border-border p-5" role="alert">
                <p className="text-sm text-muted">{charactersLibrary.loadError}</p>
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshWorldCharacters(props.world.id)}>Try again</button>
              </section>
            ) : <p className="text-sm text-muted" role="status">Loading this world’s characters…</p>
          ) : worldCharacters.length === 0 ? (
            <p className="text-sm text-muted">No characters in this world yet.</p>
          ) : (
            <ul className="grid list-none gap-4 p-0">
              {worldCharacters.map((character) => (
                <li key={character.id} className="flex flex-wrap items-start justify-between gap-3 border-bs border-border pbs-4 first:border-0 first:pbs-0">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Avatar name={character.name} imageId={character.avatar_id} className="size-11 text-base" />
                    <div className="min-w-0">
                      <h4 className="font-semibold">{character.name}</h4>
                      <p className="mbs-1 whitespace-pre-wrap text-sm leading-6 text-muted">{character.description}</p>
                    </div>
                  </div>
                  <div className="flex flex-none items-center gap-1">
                    <button
                      type="button"
                      className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                      aria-label={`Edit ${character.name}`}
                      onClick={(event) => {
                        characterOpenerRef.current = event.currentTarget;
                        setCharacterEditor({ character });
                      }}
                      disabled={busyCharacterId !== null}
                    ><Pencil className="size-4" aria-hidden="true" /></button>
                    <button
                      type="button"
                      className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                      aria-label={`Copy ${character.name} to your library`}
                      onClick={() => { void copyCharacter(character); }}
                      disabled={busyCharacterId !== null}
                    ><Copy className="size-4" aria-hidden="true" /></button>
                    <button
                      type="button"
                      className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                      aria-label={`Delete ${character.name}`}
                      onClick={() => { void removeWorldCharacter(character); }}
                      disabled={busyCharacterId !== null}
                    ><Trash2 className="size-4" aria-hidden="true" /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

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
                          {entry.kind !== "scene" && (
                            <p className="flex items-start gap-1.5 text-xs leading-5 text-muted">
                              <KeyRound className="mbs-0.5 size-3.5 flex-none" aria-hidden="true" />
                              <span className="min-w-0 break-words">{entry.keywords.length > 0 ? `Keywords: ${entry.keywords.join(", ")}` : "Always included"}</span>
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <section className="grid gap-4 rounded-xl border border-border bg-raised p-5" aria-labelledby="world-stats-title">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Reusable meters</p>
              <h3 id="world-stats-title" className="mbs-1 text-lg font-semibold">Stats</h3>
              <p className="mbs-1 max-w-2xl text-sm leading-6 text-muted">Scales that campaigns of {props.world.name} can track for characters and relationships. Bank stats can only be imported when a world is created.</p>
            </div>
            <button
              type="button"
              className="pressable inline-flex min-h-10 flex-none items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
              onClick={(event) => {
                statOpenerRef.current = event.currentTarget;
                setStatEditor({ stat: null });
              }}
            >
              <Plus className="size-4" aria-hidden="true" />Add stat
            </button>
          </header>

          {statsLibrary.refreshError && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
              {statsLibrary.refreshError}
              <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => refreshWorldStats(props.world.id)}>Retry</button>
            </p>
          )}
          {actionError && <p className="text-sm text-muted" role="alert">{actionError}</p>}

          {statsLibrary.items === undefined ? (
            statsLibrary.loadError ? (
              <section className="grid justify-items-start gap-3 rounded-lg border border-border p-5" role="alert">
                <p className="text-sm text-muted">{statsLibrary.loadError}</p>
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshWorldStats(props.world.id)}>Try again</button>
              </section>
            ) : <p className="text-sm text-muted" role="status">Loading this world's stats…</p>
          ) : worldStats.length === 0 ? (
            <p className="text-sm text-muted">No stats in this world yet.</p>
          ) : (
            <StatDefinitionList
              stats={worldStats}
              busy={deletingStatId !== null}
              onDelete={(stat) => { void removeStat(stat); }}
              onEdit={(stat) => setStatEditor({ stat })}
            />
          )}
        </section>
      </section>

      {editor && (
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="backdrop fixed inset-0 z-30 bg-black/40" />
          <DialogPrimitive.Content
            onEscapeKeyDown={keepEscapeInFindPanel}
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
                  <div className="grid gap-2 text-sm font-medium">
                    <span id="compendium-entry-description">Description</span>
                    <TextEditor
                      labelledBy="compendium-entry-description"
                      value={editor.description}
                      onChange={(description) => setEditor({ ...editor, description })}
                      className="min-h-64 rounded-lg border border-border bg-background font-normal"
                    />
                  </div>
                  {editor.kind !== "scene" && (
                    <div className="grid gap-4">
                      <label className="grid gap-2 text-sm font-medium">
                        Keywords
                        <input
                          autoComplete="off"
                          value={editor.keywords}
                          onChange={(event) => setEditor({ ...editor, keywords: event.target.value })}
                          placeholder="Comma-separated"
                          aria-describedby="compendium-entry-keywords-help"
                          className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        />
                        <span id="compendium-entry-keywords-help" className="text-xs font-normal text-muted">No keywords: always included. With keywords: included only when a keyword or the entry name comes up in recent messages.</span>
                      </label>
                      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-4">
                        <label className="grid content-start gap-2 text-sm font-medium">
                          Priority
                          <input
                            type="number"
                            inputMode="numeric"
                            required
                            min={0}
                            max={1000}
                            step={1}
                            value={editor.priority}
                            onChange={(event) => setEditor({ ...editor, priority: event.target.value })}
                            aria-describedby="compendium-entry-priority-help"
                            className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          />
                          <span id="compendium-entry-priority-help" className="text-xs font-normal text-muted">Higher goes first when space runs out.</span>
                        </label>
                        <label className="grid content-start gap-2 text-sm font-medium">
                          Stays active for N more messages
                          <input
                            type="number"
                            inputMode="numeric"
                            required
                            min={0}
                            max={50}
                            step={1}
                            value={editor.sticky}
                            onChange={(event) => setEditor({ ...editor, sticky: event.target.value })}
                            className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          />
                        </label>
                      </div>
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
                  {saving ? "Saving…" : editor.id ? "Save changes" : `Add ${ENTRY_LABELS[editor.kind]}`}
                </button>
              </footer>
            </form>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}

      {characterEditor && (
        <CharacterProfileDialog
          character={characterEditor.character}
          title={characterEditor.character ? "Edit world character" : "Create a world character"}
          description={`This character belongs to ${props.world.name}.`}
          openerRef={characterOpenerRef}
          onCreate={(input) => createWorldCharacter(props.world.id, input)}
          onUpdate={updateCharacter}
          onAvatarUpload={uploadCharacterAvatar}
          onAvatarRemove={deleteCharacterAvatar}
          onSaved={(saved, previousId) => applyWorldCharacterSaved(props.world.id, saved, previousId)}
          onClose={() => setCharacterEditor(null)}
        />
      )}

      {statEditor && (
        <StatDefinitionEditor
          stat={statEditor.stat}
          title={statEditor.stat ? `Edit ${statEditor.stat.label}` : "Add a world stat"}
          description={statEditor.stat ? "Changes apply to new campaigns; existing campaigns keep their copy." : `This stat belongs to ${props.world.name}.`}
          openerRef={statOpenerRef}
          onCreate={(input) => createWorldStat(props.world.id, input)}
          onUpdate={updateStat}
          onSaved={(saved, previousId) => applyWorldStatSaved(props.world.id, saved, previousId)}
          onClose={() => setStatEditor(null)}
        />
      )}
    </DialogPrimitive.Root>
  );
}
