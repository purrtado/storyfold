import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Globe2, Pencil, Plus, Search } from "lucide-react";
import type { World } from "../../shared/domain";
import { createWorld, updateWorld, type WorldInput } from "../lib/storyApi";
import { refreshWorlds, useWorlds, worldsLibrary } from "../lib/libraryCache";
import { AppHeader } from "./AppHeader";

const emptyWorld: WorldInput = {
  name: "",
  setting_brief: "",
  suggested_starting_situation: "",
};

export function WorldsPage(props: {
  onOpenSidebar: () => void;
  onSelect: (world: World) => void;
}) {
  const library = useWorlds();
  const worlds = library.items;
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ id: string | null; value: WorldInput } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    refreshWorlds();
  }, []);

  const coldLoading = worlds === undefined && library.loadError === undefined;
  useEffect(() => {
    if (!coldLoading) return;
    const timer = window.setTimeout(() => setShowSkeleton(true), 200);
    return () => window.clearTimeout(timer);
  }, [coldLoading]);

  const visibleWorlds = useMemo(() => {
    const current = worlds ?? [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return current;
    return current.filter((world) =>
      [world.name, world.setting_brief, world.suggested_starting_situation]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [query, worlds]);

  const openNew = () => {
    setEditor({ id: null, value: { ...emptyWorld } });
    setSaveError("");
  };

  const openEdit = (world: World) => {
    setEditor({
      id: world.id,
      value: {
        name: world.name,
        setting_brief: world.setting_brief,
        suggested_starting_situation: world.suggested_starting_situation,
      },
    });
    setSaveError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    const input = {
      name: editor.value.name.trim(),
      setting_brief: editor.value.setting_brief.trim(),
      suggested_starting_situation: editor.value.suggested_starting_situation.trim(),
    };
    setSaving(true);
    setSaveError("");
    try {
      const saved = editor.id
        ? await updateWorld(editor.id, input)
        : await createWorld(input);
      worldsLibrary.applySaved(saved, editor.id ?? undefined);
      setEditor(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save this world.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="Worlds" onOpenSidebar={props.onOpenSidebar} />
      <div className="chat-scroll min-block-size-0 flex-1">
        <main className="mx-auto w-full max-w-5xl [padding-inline:clamp(1rem,0.75rem+1vw,2rem)] [padding-block:clamp(1.5rem,1.25rem+1vw,2rem)]">
          <header className="mbe-6 flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Your library</p>
              <h1 className="mbs-2 text-3xl font-semibold tracking-tight">Worlds</h1>
              <p className="mbs-2 text-sm leading-6 text-muted">
                Reusable settings for independent stories. Changes here shape new campaigns, not existing ones.
              </p>
            </div>
            <button
              type="button"
              className="pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90"
              onClick={openNew}
            >
              <Plus className="size-4" aria-hidden="true" />
              Create world
            </button>
          </header>

          {editor && (
            <section className="mbe-6 rounded-xl border border-border bg-surface p-5" aria-labelledby="world-editor-title">
              <form className="grid gap-4" onSubmit={submit}>
                <div>
                  <h2 id="world-editor-title" className="text-lg font-semibold">
                    {editor.id ? "Edit world" : "Create a world"}
                  </h2>
                  <p className="mbs-1 text-sm text-muted">Define the setting and a possible first scene.</p>
                </div>
                <div className="grid gap-4">
                  <label className="grid gap-1.5 text-sm font-medium">
                    Name
                    <input
                      required
                      autoComplete="off"
                      value={editor.value.name}
                      onChange={(event) => setEditor({ ...editor, value: { ...editor.value, name: event.target.value } })}
                      className="min-h-11 rounded-lg border border-border bg-raised px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm font-medium">
                    Setting brief
                    <textarea
                      required
                      rows={4}
                      value={editor.value.setting_brief}
                      onChange={(event) => setEditor({ ...editor, value: { ...editor.value, setting_brief: event.target.value } })}
                      className="min-h-28 resize-y rounded-lg border border-border bg-raised px-3 py-2 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm font-medium">
                    Suggested starting situation <span className="font-normal text-muted">Optional</span>
                    <textarea
                      rows={3}
                      value={editor.value.suggested_starting_situation}
                      onChange={(event) => setEditor({ ...editor, value: { ...editor.value, suggested_starting_situation: event.target.value } })}
                      className="min-h-24 resize-y rounded-lg border border-border bg-raised px-3 py-2 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                  </label>
                </div>
                {saveError && <p className="text-sm text-muted" role="alert">{saveError}</p>}
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 py-2 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setEditor(null)} disabled={saving}>Cancel</button>
                  <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>
                    {saving ? "Saving…" : editor.id ? "Save changes" : "Create world"}
                  </button>
                </div>
              </form>
            </section>
          )}

          <div className="mbe-5 flex flex-wrap items-center gap-3">
            <label className="flex min-h-11 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-raised px-3 text-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
              <Search className="size-4 shrink-0" aria-hidden="true" />
              <span className="sr-only">Search worlds</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search worlds"
                className="min-w-0 flex-1 bg-transparent py-2 text-base text-foreground outline-hidden placeholder:text-muted/70"
              />
            </label>
            {worlds !== undefined && <p className="text-sm text-muted" role="status">{visibleWorlds.length} {visibleWorlds.length === 1 ? "world" : "worlds"}</p>}
            {worlds !== undefined && library.refreshError && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                {library.refreshError}
                <button
                  type="button"
                  className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                  onClick={() => refreshWorlds()}
                >
                  Retry
                </button>
              </p>
            )}
          </div>

          {coldLoading ? (
            showSkeleton ? (
              <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4 p-0" aria-hidden="true">
                {[0, 1, 2, 3].map((key) => (
                  <li key={key}>
                    <div className="flex h-full flex-col gap-4 rounded-xl border border-border bg-raised p-5 motion-safe:animate-pulse">
                      <div className="flex items-start gap-3">
                        <div className="mbs-1 size-5 shrink-0 rounded-full bg-muted" />
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
            ) : (
              <p className="sr-only" role="status">Loading worlds…</p>
            )
          ) : worlds === undefined ? (
            <section className="grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
              <p className="text-sm text-muted">{library.loadError}</p>
              <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => refreshWorlds()}>Try again</button>
            </section>
          ) : visibleWorlds.length === 0 ? (
            <section className="grid justify-items-center gap-3 rounded-xl border border-dashed border-border px-5 py-12 text-center">
              <Globe2 className="size-6 text-muted" aria-hidden="true" />
              <h2 className="font-semibold">{worlds.length ? "No worlds match your search" : "Your world library is empty"}</h2>
              <p className="max-w-md text-sm text-muted">{worlds.length ? "Try another name or part of a setting brief." : "Create a world to give your next story a place to begin."}</p>
              {worlds.length === 0 && <button type="button" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg" onClick={openNew}>Create world</button>}
              {worlds.length > 0 && <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setQuery("")}>Clear search</button>}
            </section>
          ) : (
            <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4 p-0">
              {visibleWorlds.map((world) => (
                <li key={world.id}>
                  <article className="flex h-full flex-col gap-4 rounded-xl border border-border bg-raised p-5">
                    <div className="flex items-start gap-3">
                      <Globe2 className="mbs-1 size-5 shrink-0 text-accent" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <h2 className="text-lg font-semibold leading-snug">{world.name}</h2>
                        <p className="mbs-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-muted">{world.setting_brief}</p>
                      </div>
                    </div>
                    {world.suggested_starting_situation && (
                      <div className="border-s border-border ps-3">
                        <p className="text-xs font-medium text-muted">Suggested starting situation</p>
                        <p className="mbs-1 line-clamp-3 whitespace-pre-wrap text-sm leading-6">{world.suggested_starting_situation}</p>
                      </div>
                    )}
                    <div className="[margin-block-start:auto] flex flex-wrap gap-2 border-bs border-border pbs-3">
                      <button type="button" className="pressable inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => openEdit(world)}>
                        <Pencil className="size-4" aria-hidden="true" />Edit
                      </button>
                      <button type="button" className="pressable min-h-10 flex-1 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" onClick={() => props.onSelect(world)}>
                        Use in a campaign
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
  );
}
