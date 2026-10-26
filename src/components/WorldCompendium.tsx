import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import type { World, WorldEntry, WorldEntryKind } from "../../shared/domain";
import {
  createWorldEntry,
  deleteWorldEntry,
  updateWorldEntry,
  type WorldEntryInput,
} from "../lib/storyApi";
import {
  applyWorldEntryRemoved,
  applyWorldEntrySaved,
  ensureWorldEntries,
  refreshWorldEntries,
  useWorldEntries,
} from "../lib/libraryCache";
import { keepEscapeInFindPanel, TextEditor } from "./TextEditor";
import { worldEntryGroups } from "../lib/worldEntryGroups";

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

export function WorldCompendium(props: { world: World }) {
  const entriesLibrary = useWorldEntries(props.world.id);
  const [editor, setEditor] = useState<EntryEditor | null>(null);
  const entryOpenerRef = useRef<HTMLElement | null>(null);
  const [saveError, setSaveError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const entries = useMemo(
    () => [...(entriesLibrary.items ?? [])].sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [entriesLibrary.items],
  );

  useEffect(() => {
    ensureWorldEntries(props.world.id);
  }, [props.world.id]);

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
    if (!window.confirm(`Delete “${entry.name}” from ${props.world.name}? Every chat in this world stops seeing it.`)) return;
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

  const loading = entriesLibrary.items === undefined && entriesLibrary.loadError === undefined;

  return (
    <DialogPrimitive.Root
      open={editor !== null}
      onOpenChange={(open) => { if (!open) setEditor(null); }}
    >
      <section
        id={`world-compendium-${props.world.id}`}
        className="grid gap-5 rounded-xl border border-border bg-surface p-5"
        aria-labelledby="world-compendium-title"
      >
        <header>
          <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">World compendium</p>
          <h2 id="world-compendium-title" className="mbs-1 text-xl font-semibold">Places, lore and opening scenes</h2>
          <p className="mbs-1 text-sm text-muted">Every chat in {props.world.name} reads these live. Opening scenes are templates for a new chat’s opening.</p>
        </header>

        {entriesLibrary.refreshError && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
            {entriesLibrary.refreshError}
            <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => refreshWorldEntries(props.world.id)}>Retry</button>
          </p>
        )}
        {actionError && <p className="text-sm text-muted" role="alert">{actionError}</p>}

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

    </DialogPrimitive.Root>
  );
}
