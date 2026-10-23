import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus, Search, UserRound } from "lucide-react";
import type { Character } from "../../shared/domain";
import { CHARACTER_PROFILE_FIELDS } from "../../shared/domain";
import {
  createCharacter,
  deleteCharacterAvatar,
  updateCharacter,
  uploadCharacterAvatar,
} from "../lib/storyApi";
import { charactersLibrary, refreshCharacters, useCharacters } from "../lib/libraryCache";
import { AppHeader } from "./AppHeader";
import { Avatar } from "./Avatar";
import { CharacterProfileDialog } from "./CharacterProfileDialog";

const detailFields = CHARACTER_PROFILE_FIELDS.filter(({ required }) => !required);

export function CharactersPage(props: {
  onOpenSidebar: () => void;
  onSelect: (character: Character) => void;
}) {
  const library = useCharacters();
  const characters = library.items;
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ character: Character | null } | null>(null);
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
      [character.name, character.description, ...detailFields.map(({ key }) => character[key])]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [characters, query]);

  const openNew = () => {
    setEditor({ character: null });
  };

  const openEdit = (character: Character) => {
    setEditor({ character });
  };

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
        <AppHeader title="Characters" onOpenSidebar={props.onOpenSidebar} />
        <div className="chat-scroll min-block-size-0 flex-1">
          <main className="mx-auto w-full max-w-5xl [padding-inline:clamp(1rem,0.75rem+1vw,2rem)] [padding-block:clamp(1.5rem,1.25rem+1vw,2rem)]">
            <header className="mbe-6 flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Your library</p>
                <h1 className="mbs-2 text-3xl font-semibold tracking-tight">Characters</h1>
                <p className="mbs-2 text-sm leading-6 text-muted">
                  Reusable characters for your stories.
                </p>
              </div>
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
                  <button type="button" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg" onClick={(event) => {
                    editorOpenerRef.current = event.currentTarget;
                    openNew();
                  }}>Create character</button>
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
                          {detailFields.filter(({ key }) => character[key]).map(({ key, label }) => (
                            <p key={key} className="mbs-2 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted">
                              <span className="font-medium text-foreground">{label}:</span> {character[key]}
                            </p>
                          ))}
                        </div>
                      </div>
                      <div className="[margin-block-start:auto] flex flex-wrap gap-2 border-bs border-border pbs-3">
                        <button type="button" className="pressable inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={(event) => {
                          editorOpenerRef.current = event.currentTarget;
                          openEdit(character);
                        }}>
                          <Pencil className="size-4" aria-hidden="true" />Edit
                        </button>
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

      {editor && (
        <CharacterProfileDialog
          character={editor.character}
          title={editor.character ? "Edit character" : "Create a character"}
          description="Build a reusable character definition."
          openerRef={editorOpenerRef}
          onCreate={createCharacter}
          onUpdate={updateCharacter}
          onAvatarUpload={uploadCharacterAvatar}
          onAvatarRemove={deleteCharacterAvatar}
          onSaved={(saved, previousId) => charactersLibrary.applySaved(saved, previousId)}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
