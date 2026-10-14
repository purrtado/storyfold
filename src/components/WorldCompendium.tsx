import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
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
import { worldEntryGroups } from "../lib/worldEntryGroups";

type EntryEditor = WorldEntryInput & { id: string | null };

export function WorldCompendium(props: { world: World; onClose: () => void }) {
  const library = useWorldEntries(props.world.id);
  const [editor, setEditor] = useState<EntryEditor | null>(null);
  const [saveError, setSaveError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const entries = useMemo(
    () => [...(library.items ?? [])].sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [library.items],
  );

  useEffect(() => {
    ensureWorldEntries(props.world.id);
  }, [props.world.id]);

  const openNew = (kind: WorldEntryKind) => {
    setEditor({ id: null, kind, name: "", description: "" });
    setSaveError("");
    setActionError("");
  };

  const openEdit = (entry: WorldEntry) => {
    setEditor({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
    });
    setSaveError("");
    setActionError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
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

  const remove = async (entry: WorldEntry) => {
    if (!window.confirm(`Delete “${entry.name}” from ${props.world.name}? Campaigns that already include it keep their captured copy.`)) return;
    setDeletingId(entry.id);
    setActionError("");
    try {
      await deleteWorldEntry(props.world.id, entry.id);
      applyWorldEntryRemoved(props.world.id, entry.id);
      if (editor?.id === entry.id) setEditor(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not delete this entry.");
    } finally {
      setDeletingId(null);
    }
  };

  const loading = library.items === undefined && library.loadError === undefined;

  return (
    <section
      id={`world-compendium-${props.world.id}`}
      className="mbe-6 grid gap-5 rounded-xl border border-border bg-surface p-5"
      aria-labelledby="world-compendium-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">World compendium</p>
          <h2 id="world-compendium-title" className="mbs-1 text-xl font-semibold">{props.world.name}</h2>
          <p className="mbs-1 text-sm text-muted">Characters, places, lore, and opening scenes for future campaigns.</p>
        </div>
        <button
          type="button"
          className="pressable inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
          onClick={props.onClose}
        >
          <X className="size-4" aria-hidden="true" />Close
        </button>
      </header>

      {library.refreshError && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
          {library.refreshError}
          <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => refreshWorldEntries(props.world.id)}>Retry</button>
        </p>
      )}
      {actionError && <p className="text-sm text-muted" role="alert">{actionError}</p>}

      {loading ? (
        <p className="py-4 text-sm text-muted" role="status">Loading compendium…</p>
      ) : library.loadError ? (
        <section className="grid justify-items-start gap-3 rounded-lg border border-border p-5" role="alert">
          <p className="text-sm text-muted">{library.loadError}</p>
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
                  <button
                    type="button"
                    className="pressable inline-flex min-h-10 flex-none items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                    onClick={() => openNew(group.kind)}
                  >
                    <Plus className="size-4" aria-hidden="true" />Add
                  </button>
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
                            <button
                              type="button"
                              className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                              aria-label={`Edit ${entry.name}`}
                              onClick={() => openEdit(entry)}
                              disabled={saving || deletingId !== null}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                              aria-label={`Delete ${entry.name}`}
                              onClick={() => { void remove(entry); }}
                              disabled={saving || deletingId !== null}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{entry.description}</p>
                      </li>
                    ))}
                  </ul>
                )}

                {editor && (editor.id === null ? editor.kind === group.kind : entries.find((entry) => entry.id === editor.id)?.kind === group.kind) && (
                  <form className="grid gap-3 rounded-lg border border-border bg-surface p-3" onSubmit={submit}>
                    <h4 className="font-semibold">{editor.id ? "Edit entry" : `Add ${group.label.toLocaleLowerCase()}`}</h4>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Category
                      <select
                        value={editor.kind}
                        onChange={(event) => setEditor({ ...editor, kind: event.target.value as WorldEntryKind })}
                        className="min-h-10 rounded-lg border border-border bg-raised px-3 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {worldEntryGroups.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Name
                      <input
                        required
                        autoComplete="off"
                        value={editor.name}
                        onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                        className="min-h-10 rounded-lg border border-border bg-raised px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Description
                      <textarea
                        required
                        rows={4}
                        value={editor.description}
                        onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                        className="min-h-24 resize-y rounded-lg border border-border bg-raised px-3 py-2 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      />
                    </label>
                    {saveError && <p className="text-sm text-muted" role="alert">{saveError}</p>}
                    <div className="flex flex-wrap justify-end gap-2">
                      <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setEditor(null)} disabled={saving}>Cancel</button>
                      <button type="submit" className="pressable min-h-10 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>
                        {saving ? "Saving…" : editor.id ? "Save changes" : "Add entry"}
                      </button>
                    </div>
                  </form>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
