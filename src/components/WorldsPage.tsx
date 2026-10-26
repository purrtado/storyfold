import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Globe2, Plus, Search } from "lucide-react";
import { STAT_KINDS } from "../../shared/domain";
import { createWorld, type WorldInput } from "../lib/storyApi";
import { refreshStats, refreshWorlds, useStats, useWorlds, worldsLibrary } from "../lib/libraryCache";
import { AppHeader } from "./AppHeader";
import { STAT_KIND_LABELS } from "./StatDefinitionList";
import { TextEditor } from "./TextEditor";

const emptyWorld: WorldInput = {
  name: "",
  setting_brief: "",
};

export function WorldsPage(props: { onOpenSidebar: () => void }) {
  const navigate = useNavigate();
  const library = useWorlds();
  const worlds = library.items;
  const bankLibrary = useStats();
  const bankStats = bankLibrary.items;
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ value: WorldInput; statIds: string[] } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    refreshWorlds();
    refreshStats();
  }, []);

  const coldLoading = worlds === undefined && library.loadError === undefined;
  useEffect(() => {
    if (!coldLoading) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), 200);
    return () => window.clearTimeout(timer);
  }, [coldLoading]);

  const visibleWorlds = useMemo(() => {
    const current = worlds ?? [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return current;
    return current.filter((world) =>
      [world.name, world.setting_brief]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [query, worlds]);

  const openNew = () => {
    setEditor({ value: { ...emptyWorld }, statIds: [] });
    setSaveError("");
  };

  const toggleBankStat = (statId: string) => {
    setEditor((current) => current && {
      ...current,
      statIds: current.statIds.includes(statId)
        ? current.statIds.filter((id) => id !== statId)
        : [...current.statIds, statId],
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    const input = {
      name: editor.value.name.trim(),
      setting_brief: editor.value.setting_brief.trim(),
    };
    if (!input.setting_brief) {
      setSaveError("Add a setting brief.");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const saved = await createWorld({ ...input, ...(editor.statIds.length ? { stat_ids: editor.statIds } : {}) });
      worldsLibrary.applySaved(saved, undefined);
      setEditor(null);
      navigate(`/worlds/${encodeURIComponent(saved.id)}`);
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
                Each world is the living save for its stories: its setting, characters and compendium are shared by every chat you start in it.
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
                    Create a world
                  </h2>
                  <p className="mbs-1 text-sm text-muted">Define the setting. Add characters, places and opening scenes from the world once it exists.</p>
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
                  <div className="grid gap-1.5 text-sm font-medium">
                    <span id="world-setting-brief">Setting brief</span>
                    <TextEditor
                      labelledBy="world-setting-brief"
                      value={editor.value.setting_brief}
                      onChange={(setting_brief) => setEditor({ ...editor, value: { ...editor.value, setting_brief } })}
                      className="min-h-28 rounded-lg border border-border bg-raised font-normal"
                    />
                  </div>
                  <fieldset className="grid gap-2 text-sm font-medium">
                    <legend>
                      Import stats from the bank <span className="font-normal text-muted">Optional</span>
                    </legend>
                    {bankStats === undefined ? (
                      bankLibrary.loadError ? (
                        <div className="grid justify-items-start gap-2" role="alert">
                          <p className="font-normal text-muted">{bankLibrary.loadError}</p>
                          <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshStats()}>Try again</button>
                        </div>
                      ) : <p className="font-normal text-muted" role="status">Loading stats…</p>
                    ) : bankStats.length === 0 ? (
                      <p className="font-normal text-muted">The bank has no stats yet. Add them under Settings → Stats.</p>
                    ) : (
                      STAT_KINDS.map((kind) => {
                        const group = bankStats.filter((stat) => stat.applies_to === kind);
                        if (group.length === 0) return null;
                        return (
                          <div key={kind} className="grid gap-1.5">
                            <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">{STAT_KIND_LABELS[kind]}</p>
                            <ul className="grid list-none gap-1 p-0 sm:grid-cols-2">
                              {group.map((stat) => (
                                <li key={stat.id}>
                                  <label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
                                    <input
                                      type="checkbox"
                                      className="size-4 flex-none accent-accent"
                                      checked={editor.statIds.includes(stat.id)}
                                      onChange={() => toggleBankStat(stat.id)}
                                    />
                                    <span className="size-3 flex-none rounded-full" style={{ background: `var(--stat-${stat.color})` }} aria-hidden="true" />
                                    <span className="min-w-0 truncate">{stat.label}</span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })
                    )}
                  </fieldset>
                </div>
                {saveError && <p className="text-sm text-muted" role="alert">{saveError}</p>}
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 py-2 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setEditor(null)} disabled={saving}>Cancel</button>
                  <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>
                    {saving ? "Saving…" : "Create world"}
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
                  className="pressable min-h-11 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                  onClick={() => refreshWorlds()}
                >
                  Retry
                </button>
              </p>
            )}
          </div>

          {coldLoading ? (
            <div className="[min-block-size:14rem]">
              <p className="sr-only" role="status">Loading worlds…</p>
              {showSkeleton && (
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
              )}
            </div>
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
                    <Link
                      to={`/worlds/${encodeURIComponent(world.id)}`}
                      className="pressable [margin-block-start:auto] inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg no-underline whitespace-nowrap [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90"
                    >
                      Open world
                    </Link>
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
