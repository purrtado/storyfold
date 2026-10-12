import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Pencil, Plus, Search, UserRound } from "lucide-react";
import type { Persona } from "../../shared/domain";
import { createPersona, fetchPersonas, updatePersona, type PersonaInput } from "../lib/storyApi";
import { AppHeader } from "./AppHeader";

const emptyPersona: PersonaInput = { name: "", description: "" };

export function PersonasPage(props: {
  onOpenSidebar: () => void;
  onSelect: (persona: Persona) => void;
}) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ id: string | null; value: PersonaInput } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    fetchPersonas().then(
      (items) => {
        if (active) setPersonas(items);
      },
      (error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Could not load personas.");
      },
    ).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reloadKey]);

  const visiblePersonas = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return personas;
    return personas.filter((persona) =>
      [persona.name, persona.description]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [personas, query]);

  const openNew = () => {
    setEditor({ id: null, value: { ...emptyPersona } });
    setSaveError("");
  };

  const openEdit = (persona: Persona) => {
    setEditor({
      id: persona.id,
      value: { name: persona.name, description: persona.description },
    });
    setSaveError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    const input = {
      name: editor.value.name.trim(),
      description: editor.value.description.trim(),
    };
    setSaving(true);
    setSaveError("");
    try {
      const saved = editor.id
        ? await updatePersona(editor.id, input)
        : await createPersona(input);
      setPersonas((current) => editor.id
        ? current.map((persona) => persona.id === saved.id ? saved : persona)
        : [saved, ...current],
      );
      setEditor(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save this persona.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="Personas" onOpenSidebar={props.onOpenSidebar} />
      <div className="chat-scroll min-block-size-0 flex-1">
        <main className="mx-auto w-full max-w-5xl [padding-inline:clamp(1rem,0.75rem+1vw,2rem)] [padding-block:clamp(1.5rem,1.25rem+1vw,2rem)]">
          <header className="mbe-6 flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Your library</p>
              <h1 className="mbs-2 text-3xl font-semibold tracking-tight">Personas</h1>
              <p className="mbs-2 text-sm leading-6 text-muted">
                Reusable identities for the characters you play. Campaigns keep their own captured context and speaker names.
              </p>
            </div>
            <button
              type="button"
              className="pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90"
              onClick={openNew}
            >
              <Plus className="size-4" aria-hidden="true" />
              Create persona
            </button>
          </header>

          {editor && (
            <section className="mbe-6 rounded-xl border border-border bg-surface p-5" aria-labelledby="persona-editor-title">
              <form className="grid gap-4" onSubmit={submit}>
                <div>
                  <h2 id="persona-editor-title" className="text-lg font-semibold">
                    {editor.id ? "Edit persona" : "Create a persona"}
                  </h2>
                  <p className="mbs-1 text-sm text-muted">Describe the identity you want to bring into a story.</p>
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
                    Description
                    <textarea
                      required
                      rows={5}
                      value={editor.value.description}
                      onChange={(event) => setEditor({ ...editor, value: { ...editor.value, description: event.target.value } })}
                      className="min-h-32 resize-y rounded-lg border border-border bg-raised px-3 py-2 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                  </label>
                </div>
                {saveError && <p className="text-sm text-muted" role="alert">{saveError}</p>}
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 py-2 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setEditor(null)} disabled={saving}>Cancel</button>
                  <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>
                    {saving ? "Saving…" : editor.id ? "Save changes" : "Create persona"}
                  </button>
                </div>
              </form>
            </section>
          )}

          <div className="mbe-5 flex flex-wrap items-center gap-3">
            <label className="flex min-h-11 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-raised px-3 text-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
              <Search className="size-4 shrink-0" aria-hidden="true" />
              <span className="sr-only">Search personas</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search personas"
                className="min-w-0 flex-1 bg-transparent py-2 text-base text-foreground outline-hidden placeholder:text-muted/70"
              />
            </label>
            {!loading && !loadError && <p className="text-sm text-muted" role="status">{visiblePersonas.length} {visiblePersonas.length === 1 ? "persona" : "personas"}</p>}
          </div>

          {loading ? (
            <p className="py-8 text-sm text-muted" role="status">Loading personas…</p>
          ) : loadError ? (
            <section className="grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
              <p className="text-sm text-muted">{loadError}</p>
              <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setReloadKey((key) => key + 1)}>Try again</button>
            </section>
          ) : visiblePersonas.length === 0 ? (
            <section className="grid justify-items-center gap-3 rounded-xl border border-dashed border-border px-5 py-12 text-center">
              <UserRound className="size-6 text-muted" aria-hidden="true" />
              <h2 className="font-semibold">{personas.length ? "No personas match your search" : "Your persona library is empty"}</h2>
              <p className="max-w-md text-sm text-muted">{personas.length ? "Try another name or part of a description." : "Create a persona to decide who you will play in a story."}</p>
              {personas.length === 0 && <button type="button" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg" onClick={openNew}>Create persona</button>}
              {personas.length > 0 && <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setQuery("")}>Clear search</button>}
            </section>
          ) : (
            <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4 p-0">
              {visiblePersonas.map((persona) => (
                <li key={persona.id}>
                  <article className="flex h-full flex-col gap-4 rounded-xl border border-border bg-raised p-5">
                    <div className="flex items-start gap-3">
                      <span className="grid size-11 shrink-0 place-items-center rounded-full border border-accent/20 bg-accent-soft text-accent"><UserRound className="size-5" aria-hidden="true" /></span>
                      <div className="min-w-0 flex-1">
                        <h2 className="text-lg font-semibold leading-snug">{persona.name}</h2>
                        <p className="mbs-2 line-clamp-6 whitespace-pre-wrap text-sm leading-6 text-muted">{persona.description}</p>
                      </div>
                    </div>
                    <div className="[margin-block-start:auto] flex flex-wrap gap-2 border-bs border-border pbs-3">
                      <button type="button" className="pressable inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => openEdit(persona)}>
                        <Pencil className="size-4" aria-hidden="true" />Edit
                      </button>
                      <button type="button" className="pressable min-h-10 flex-1 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" onClick={() => props.onSelect(persona)}>
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
