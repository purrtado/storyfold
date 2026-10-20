import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Globe2, UserRound } from "lucide-react";
import type { Campaign, Character, Session, WorldEntry, WorldEntryKind } from "../../shared/domain";
import { GROUNDING_CHARACTER_LIMIT, groundingCharacterCount } from "../../shared/grounding";
import { createCampaign } from "../lib/storyApi";
import {
  ensureWorldCharacters,
  ensureWorldEntries,
  refreshCharacters,
  refreshWorldCharacters,
  refreshWorldEntries,
  refreshWorlds,
  useCharacters,
  useWorldCharacters,
  useWorldEntries,
  useWorlds,
} from "../lib/libraryCache";
import { AppHeader } from "./AppHeader";
import { Avatar } from "./Avatar";
import { worldEntryGroups } from "../lib/worldEntryGroups";

type Draft = {
  worldId: string;
  protagonistId: string;
  name: string;
  startingSituation: string;
  situationEdited: boolean;
  selectedCharacterIds: string[];
  selectedEntryIds: string[];
};

const characterFieldLabels = [
  ["appearance", "Appearance"],
  ["personality", "Personality"],
  ["background", "Background"],
  ["baseline_motivations", "Baseline motivations"],
  ["speaking_style", "Speaking style"],
] as const;

function CharacterGroundingPreview(props: {
  character: Character;
  worldContext: string;
  source: string;
}) {
  return (
    <article className="grid gap-2 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="flex items-center gap-2 font-semibold">
          <Avatar name={props.character.name} imageId={props.character.avatar_id} className="size-6 text-[0.625rem]" />
          {props.character.name}
        </h4>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{props.source}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{props.character.description}</p>
      {characterFieldLabels.filter(([field]) => props.character[field]).map(([field, label]) => (
        <p key={field} className="whitespace-pre-wrap text-sm leading-6 text-muted">
          <span className="font-medium text-foreground">{label}:</span> {props.character[field]}
        </p>
      ))}
      <p className="whitespace-pre-wrap text-sm leading-6 text-muted">
        <span className="font-medium text-foreground">World-specific context:</span> {props.worldContext || "None"}
      </p>
    </article>
  );
}

export function NewCampaignPage(props: {
  onOpenSidebar: () => void;
  selectedWorldId: string | null;
  selectedCharacterId: string | null;
  onStarted: (campaign: Campaign, session: Session) => void;
}) {
  const worldsState = useWorlds();
  const charactersState = useCharacters();
  const worlds = worldsState.items;
  const characters = charactersState.items;
  const [draft, setDraft] = useState<Draft>({
    worldId: props.selectedWorldId ?? "",
    protagonistId: props.selectedCharacterId ?? "",
    name: "",
    startingSituation: "",
    situationEdited: false,
    selectedCharacterIds: [],
    selectedEntryIds: [],
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const seededWorldId = useRef<string | null | undefined>(undefined);
  const seededCharacterId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    refreshWorlds();
    refreshCharacters();
  }, []);

  useEffect(() => {
    if (worlds === undefined || characters === undefined) return;
    const worldSeedChanged = props.selectedWorldId !== seededWorldId.current;
    const characterSeedChanged = props.selectedCharacterId !== seededCharacterId.current;
    seededWorldId.current = props.selectedWorldId;
    seededCharacterId.current = props.selectedCharacterId;
    setDraft((current) => {
      const nextWorldId = worldSeedChanged && worlds.some((item) => item.id === props.selectedWorldId)
        ? props.selectedWorldId!
        : worlds.some((item) => item.id === current.worldId)
          ? current.worldId
          : worlds[0]?.id ?? "";
      const nextProtagonistId = characterSeedChanged && characters.some((item) => item.id === props.selectedCharacterId)
        ? props.selectedCharacterId!
        : characters.some((item) => item.id === current.protagonistId)
          ? current.protagonistId
          : characters[0]?.id ?? "";
      const worldChanged = nextWorldId !== current.worldId;
      const situationChanged = worldChanged && !current.situationEdited;
      return {
        ...current,
        worldId: nextWorldId,
        protagonistId: nextProtagonistId,
        startingSituation: situationChanged
          ? worlds.find((item) => item.id === nextWorldId)?.suggested_starting_situation ?? ""
          : current.startingSituation,
        selectedCharacterIds: worldChanged
          ? []
          : current.selectedCharacterIds.filter((id) => id !== nextProtagonistId),
        selectedEntryIds: worldChanged ? [] : current.selectedEntryIds,
      };
    });
  }, [worlds, characters, props.selectedCharacterId, props.selectedWorldId]);

  const world = worlds?.find((item) => item.id === draft.worldId);
  const protagonist = characters?.find((item) => item.id === draft.protagonistId);
  const worldEntriesState = useWorldEntries(draft.worldId);
  const worldCharactersState = useWorldCharacters(draft.worldId);
  useEffect(() => {
    if (!draft.worldId) return;
    ensureWorldEntries(draft.worldId);
    ensureWorldCharacters(draft.worldId);
  }, [draft.worldId]);

  const worldEntries = useMemo(
    () => [...(worldEntriesState.items ?? [])].sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [worldEntriesState.items],
  );
  const worldCharacters = worldCharactersState.items ?? [];
  const worldCharacterById = useMemo(
    () => new Map(worldCharacters.map((association) => [association.character_id, association])),
    [worldCharacters],
  );
  const selectedCharacters = (characters ?? []).filter((character) =>
    character.id !== draft.protagonistId && draft.selectedCharacterIds.includes(character.id),
  );
  const selectedEntries = worldEntries.filter((entry) =>
    entry.kind !== "scene" && draft.selectedEntryIds.includes(entry.id),
  );
  const groundingCount = world && protagonist && worldEntriesState.items !== undefined && worldCharactersState.items !== undefined
    ? groundingCharacterCount({
      world_name: world.name,
      world_setting_brief: world.setting_brief,
      starting_situation: draft.startingSituation.trim(),
      protagonist: {
        name: protagonist.name,
        description: protagonist.description,
        appearance: protagonist.appearance,
        personality: protagonist.personality,
        background: protagonist.background,
        baseline_motivations: protagonist.baseline_motivations,
        speaking_style: protagonist.speaking_style,
        world_context: worldCharacterById.get(protagonist.id)?.context ?? "",
      },
      cast: selectedCharacters.map((character) => ({
        name: character.name,
        description: character.description,
        appearance: character.appearance,
        personality: character.personality,
        background: character.background,
        baseline_motivations: character.baseline_motivations,
        speaking_style: character.speaking_style,
        world_context: worldCharacterById.get(character.id)?.context ?? "",
      })),
      entries: selectedEntries.map(({ name, description }) => ({ name, description })),
    })
    : null;
  const overLimit = groundingCount !== null && groundingCount > GROUNDING_CHARACTER_LIMIT;
  const canBegin = Boolean(
    world
    && protagonist
    && worldEntriesState.items !== undefined
    && worldCharactersState.items !== undefined
    && !starting
    && !overLimit,
  );
  const coldLoadError = (worlds === undefined ? worldsState.loadError : undefined)
    ?? (characters === undefined ? charactersState.loadError : undefined);
  const refreshError = worldsState.refreshError ?? charactersState.refreshError;

  const chooseWorld = (id: string) => {
    const next = worlds?.find((item) => item.id === id);
    setDraft((current) => ({
      ...current,
      worldId: id,
      selectedCharacterIds: [],
      selectedEntryIds: [],
      startingSituation: current.situationEdited
        ? current.startingSituation
        : next?.suggested_starting_situation ?? "",
    }));
  };

  const chooseProtagonist = (id: string) => {
    setDraft((current) => ({
      ...current,
      protagonistId: id,
      selectedCharacterIds: current.selectedCharacterIds.filter((selectedId) => selectedId !== id),
    }));
  };

  const chooseScene = (scene: WorldEntry) => {
    if (
      draft.situationEdited
      && draft.startingSituation !== scene.description
      && !window.confirm("Replace your manually edited starting situation with this scene?")
    ) return;
    setDraft((current) => ({
      ...current,
      startingSituation: scene.description,
      situationEdited: false,
    }));
  };

  const toggleCharacter = (characterId: string) => {
    if (characterId === draft.protagonistId) return;
    setDraft((current) => ({
      ...current,
      selectedCharacterIds: current.selectedCharacterIds.includes(characterId)
        ? current.selectedCharacterIds.filter((id) => id !== characterId)
        : [...current.selectedCharacterIds, characterId],
    }));
  };

  const toggleAllCharacters = () => {
    const availableIds = (characters ?? [])
      .filter((character) => character.id !== draft.protagonistId)
      .map((character) => character.id);
    const allSelected = availableIds.length > 0 && availableIds.every((id) => draft.selectedCharacterIds.includes(id));
    setDraft((current) => ({
      ...current,
      selectedCharacterIds: allSelected
        ? current.selectedCharacterIds.filter((id) => !availableIds.includes(id))
        : [...new Set([...current.selectedCharacterIds, ...availableIds])],
    }));
  };

  const toggleEntry = (entryId: string) => {
    setDraft((current) => ({
      ...current,
      selectedEntryIds: current.selectedEntryIds.includes(entryId)
        ? current.selectedEntryIds.filter((id) => id !== entryId)
        : [...current.selectedEntryIds, entryId],
    }));
  };

  const toggleAllEntries = (kind: Exclude<WorldEntryKind, "scene">) => {
    const ids = worldEntries.filter((entry) => entry.kind === kind).map((entry) => entry.id);
    const allSelected = ids.length > 0 && ids.every((id) => draft.selectedEntryIds.includes(id));
    setDraft((current) => ({
      ...current,
      selectedEntryIds: allSelected
        ? current.selectedEntryIds.filter((id) => !ids.includes(id))
        : [...new Set([...current.selectedEntryIds, ...ids])],
    }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canBegin || !world || !protagonist || groundingCount === null) return;
    setStarting(true);
    setStartError("");
    try {
      const result = await createCampaign({
        world_id: world.id,
        protagonist_id: protagonist.id,
        ...(selectedCharacters.length ? { cast_character_ids: selectedCharacters.map((character) => character.id) } : {}),
        starting_situation: draft.startingSituation.trim(),
        entry_ids: draft.selectedEntryIds.filter((id) => selectedEntries.some((entry) => entry.id === id)),
        ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
      });
      props.onStarted(result.campaign, result.session);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Could not start this campaign.");
    } finally {
      setStarting(false);
    }
  };

  const castReady = worldCharactersState.items !== undefined;
  const entriesReady = worldEntriesState.items !== undefined;
  const selectableCharacters = (characters ?? []).filter((character) => character.id !== draft.protagonistId);
  const selectedCharacterCount = selectedCharacters.length;

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="New campaign" onOpenSidebar={props.onOpenSidebar} />
      <div className="chat-scroll min-block-size-0 flex-1">
        <main className="mx-auto w-full max-w-4xl [padding-inline:clamp(1rem,0.75rem+1vw,2rem)] [padding-block:clamp(1.5rem,1.25rem+1vw,2rem)]">
          <header className="mbe-7 max-w-2xl">
            <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">A new playthrough</p>
            <h1 className="mbs-2 text-3xl font-semibold tracking-tight">Where will your story begin?</h1>
            <p className="mbs-2 text-sm leading-6 text-muted">Choose a world and who you’ll play. Add narrator-controlled characters and only the world details this campaign should know.</p>
          </header>

          {coldLoadError ? (
            <section className="grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
              <p className="text-sm text-muted">{coldLoadError}</p>
              <button
                type="button"
                className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                onClick={() => { refreshWorlds(); refreshCharacters(); }}
              >Try again</button>
            </section>
          ) : worlds === undefined || characters === undefined ? (
            <p className="py-8 text-sm text-muted" role="status">Loading your library…</p>
          ) : (
            <>
              {refreshError && (
                <p className="mbe-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                  {refreshError}
                  <button
                    type="button"
                    className="pressable min-h-11 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                    onClick={() => { refreshWorlds(); refreshCharacters(); }}
                  >Retry</button>
                </p>
              )}
              {worlds.length === 0 || characters.length === 0 ? (
                <section className="grid justify-items-start gap-4 rounded-xl border border-dashed border-border p-6">
                  <h2 className="text-lg font-semibold">Your story needs a world and a character</h2>
                  <p className="text-sm text-muted">Create both definitions before starting a campaign.</p>
                  <div className="flex flex-wrap gap-2">
                    {worlds.length === 0 && <Link className="pressable inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" to="/worlds">Create a world</Link>}
                    {characters.length === 0 && <Link className="pressable inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" to="/characters">Create a character</Link>}
                  </div>
                </section>
              ) : (
                <form className="grid gap-6" onSubmit={submit}>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] gap-5">
                    <section className="grid content-start gap-3 rounded-xl border border-border bg-raised p-5">
                      <label htmlFor="campaign-world" className="flex items-center gap-2 text-sm font-semibold"><Globe2 className="size-4 text-accent" aria-hidden="true" />World</label>
                      <select id="campaign-world" className="min-h-11 rounded-lg border border-border bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" value={draft.worldId} onChange={(event) => chooseWorld(event.target.value)}>
                        {worlds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                      {world && <div className="rounded-lg bg-surface p-3"><p className="whitespace-pre-wrap text-sm leading-6 text-muted">{world.setting_brief}</p></div>}
                      <Link className="text-sm font-medium text-accent underline underline-offset-2" to="/worlds">Browse or edit worlds</Link>
                    </section>
                    <section className="grid content-start gap-3 rounded-xl border border-border bg-raised p-5">
                      <label htmlFor="campaign-protagonist" className="flex items-center gap-2 text-sm font-semibold"><UserRound className="size-4 text-accent" aria-hidden="true" />Playing as</label>
                      <select id="campaign-protagonist" className="min-h-11 rounded-lg border border-border bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" value={draft.protagonistId} onChange={(event) => chooseProtagonist(event.target.value)}>
                        {characters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                      {protagonist && <div className="rounded-lg bg-surface p-3"><p className="flex items-center gap-2 font-medium"><Avatar name={protagonist.name} imageId={protagonist.avatar_id} className="size-6 text-[0.625rem]" />{protagonist.name}</p><p className="mbs-1 whitespace-pre-wrap text-sm leading-6 text-muted">{protagonist.description}</p></div>}
                      <Link className="text-sm font-medium text-accent underline underline-offset-2" to="/characters">Browse or edit characters</Link>
                    </section>
                  </div>

                  <section className="grid gap-5 rounded-xl border border-border bg-raised p-5" aria-labelledby="campaign-context-title">
                    <header>
                      <h2 id="campaign-context-title" className="text-lg font-semibold">Choose campaign context</h2>
                      <p className="mbs-1 text-sm leading-6 text-muted">The protagonist is captured once. Select narrator-controlled characters from your library, then choose local NPCs, locations, and lore from this world.</p>
                    </header>

                    <section className="grid gap-3 rounded-lg border border-border p-4" aria-labelledby="campaign-cast-title">
                      <header>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h3 id="campaign-cast-title" className="font-semibold">Narrator-controlled cast</h3>
                            <p className="mbs-1 text-sm text-muted">{selectedCharacterCount} selected. World cast notes are included when available; library-only characters have no world-specific context.</p>
                          </div>
                          <button
                            type="button"
                            className="pressable min-h-9 rounded-lg border border-border px-3 text-xs font-medium [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                            onClick={toggleAllCharacters}
                            disabled={selectableCharacters.length === 0}
                          >
                            {selectableCharacters.length > 0 && selectableCharacters.every(({ id }) => draft.selectedCharacterIds.includes(id)) ? "Clear characters" : "Select all characters"}
                          </button>
                        </div>
                      </header>
                      {!castReady ? (
                        worldCharactersState.loadError ? (
                          <div className="grid justify-items-start gap-2" role="alert">
                            <p className="text-sm text-muted">{worldCharactersState.loadError}</p>
                            <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshWorldCharacters(draft.worldId)}>Try again</button>
                          </div>
                        ) : <p className="text-sm text-muted" role="status">Loading this world’s cast context…</p>
                      ) : selectableCharacters.length === 0 ? (
                        <p className="text-sm text-muted">No other characters are available to add to the cast.</p>
                      ) : (
                        <ul className="grid list-none gap-3 p-0">
                          {characters.map((character) => {
                            const isProtagonist = character.id === draft.protagonistId;
                            const association = worldCharacterById.get(character.id);
                            return (
                              <li key={character.id} className="border-bs border-border pbs-3 first:border-0 first:pbs-0">
                                <label className={`flex items-start gap-3 text-sm ${isProtagonist ? "text-muted" : ""}`}>
                                  <input
                                    type="checkbox"
                                    className="mbs-1 size-4 flex-none accent-accent"
                                    checked={!isProtagonist && draft.selectedCharacterIds.includes(character.id)}
                                    disabled={isProtagonist}
                                    onChange={() => toggleCharacter(character.id)}
                                  />
                                  <span className="grid min-w-0 flex-1 gap-1">
                                    <span className="flex flex-wrap items-center gap-2">
                                      <Avatar name={character.name} imageId={character.avatar_id} className="size-6 text-[0.625rem]" />
                                      <span className="font-medium text-foreground">{character.name}</span>
                                      <span className="rounded-full border border-border px-2 py-0.5 text-xs">{isProtagonist ? "Playing as" : association ? "World cast" : "Global library"}</span>
                                    </span>
                                    <span className="whitespace-pre-wrap leading-6">{character.description}</span>
                                    {!isProtagonist && association?.context && <span className="whitespace-pre-wrap leading-6 text-muted"><span className="font-medium">World context:</span> {association.context}</span>}
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>

                    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-4">
                      {worldEntryGroups.map((group) => {
                        const kind = group.kind;
                        if (kind === "scene") return null;
                        const categoryEntries = worldEntries.filter((entry) => entry.kind === kind);
                        const selectedCount = categoryEntries.filter((entry) => draft.selectedEntryIds.includes(entry.id)).length;
                        const allSelected = categoryEntries.length > 0 && selectedCount === categoryEntries.length;
                        return (
                          <fieldset key={kind} className="grid content-start gap-3 rounded-lg border border-border p-4">
                            <legend className="px-1 font-semibold">{group.label}</legend>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs text-muted">{selectedCount} of {categoryEntries.length} selected</p>
                              <button
                                type="button"
                                className="pressable min-h-9 rounded-lg border border-border px-3 text-xs font-medium [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                                onClick={() => toggleAllEntries(kind)}
                                disabled={categoryEntries.length === 0}
                              >{allSelected ? "Clear all" : "Select all"}</button>
                            </div>
                            {categoryEntries.length === 0 ? (
                              <p className="text-sm text-muted">No {group.label.toLocaleLowerCase()} in this world yet.</p>
                            ) : (
                              <ul className="grid list-none gap-3 p-0">
                                {categoryEntries.map((entry) => (
                                  <li key={entry.id} className="border-bs border-border pbs-3 first:border-0 first:pbs-0">
                                    <label className="flex items-start gap-2 text-sm">
                                      <input
                                        type="checkbox"
                                        className="mbs-1 size-4 flex-none accent-accent"
                                        checked={draft.selectedEntryIds.includes(entry.id)}
                                        onChange={() => toggleEntry(entry.id)}
                                      />
                                      <span className="grid min-w-0 gap-1">
                                        <span className="font-medium">{entry.name}</span>
                                        <span className="whitespace-pre-wrap leading-6 text-muted">{entry.description}</span>
                                      </span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </fieldset>
                        );
                      })}
                    </div>

                    <section className="grid gap-3 rounded-lg border border-border p-4" aria-labelledby="opening-scenes-title">
                      <div>
                        <h3 id="opening-scenes-title" className="font-semibold">Opening scenes</h3>
                        <p className="mbs-1 text-sm text-muted">Use a scene to fill the starting situation. Scenes are not captured as separate compendium grounding.</p>
                      </div>
                      {worldEntries.filter((entry) => entry.kind === "scene").length === 0 ? (
                        <p className="text-sm text-muted">No opening scenes in this world yet.</p>
                      ) : (
                        <ul className="grid list-none gap-3 p-0">
                          {worldEntries.filter((entry) => entry.kind === "scene").map((scene) => (
                            <li key={scene.id} className="flex flex-wrap items-start justify-between gap-3 border-bs border-border pbs-3 first:border-0 first:pbs-0">
                              <div className="min-w-0 flex-1">
                                <h4 className="font-medium">{scene.name}</h4>
                                <p className="mbs-1 whitespace-pre-wrap text-sm leading-6 text-muted">{scene.description}</p>
                              </div>
                              <button
                                type="button"
                                className="pressable min-h-10 flex-none rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                                aria-label={`Use ${scene.name} as starting situation`}
                                onClick={() => chooseScene(scene)}
                              >Use scene</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section className="grid gap-3 rounded-lg bg-surface p-4" aria-labelledby="included-campaign-context-title">
                      <div>
                        <h3 id="included-campaign-context-title" className="font-semibold">Included campaign preview</h3>
                        <p className="mbs-1 text-sm text-muted">Only the protagonist, selected cast, and selected non-scene entries are captured.</p>
                      </div>
                      {protagonist ? (
                        <div className="grid gap-3">
                          <CharacterGroundingPreview
                            character={protagonist}
                            worldContext={worldCharacterById.get(protagonist.id)?.context ?? ""}
                            source="Playing as · included once"
                          />
                          {selectedCharacters.length > 0 && (
                            <ul className="grid list-none gap-3 p-0">
                              {selectedCharacters.map((character) => (
                                <li key={character.id}>
                                  <CharacterGroundingPreview
                                    character={character}
                                    worldContext={worldCharacterById.get(character.id)?.context ?? ""}
                                    source={worldCharacterById.has(character.id) ? "Narrator cast · world cast" : "Narrator cast · global library"}
                                  />
                                </li>
                              ))}
                            </ul>
                          )}
                          {selectedEntries.length > 0 && (
                            <ul className="grid list-none gap-3 p-0">
                              {selectedEntries.map((entry) => (
                                <li key={entry.id} className="border-bs border-border pbs-3 first:border-0 first:pbs-0">
                                  <p className="text-xs font-medium text-muted">{worldEntryGroups.find((group) => group.kind === entry.kind)?.label}</p>
                                  <h4 className="mbs-1 font-medium">{entry.name}</h4>
                                  <p className="mbs-1 whitespace-pre-wrap text-sm leading-6 text-muted">{entry.description}</p>
                                </li>
                              ))}
                            </ul>
                          )}
                          {selectedCharacters.length === 0 && selectedEntries.length === 0 && <p className="text-sm text-muted">No narrator cast or compendium entries selected.</p>}
                        </div>
                      ) : <p className="text-sm text-muted">Choose a character to preview the captured context.</p>}
                    </section>

                    {worldEntriesState.loadError && !entriesReady ? (
                      <div className="grid justify-items-start gap-2" role="alert">
                        <p className="text-sm text-muted">{worldEntriesState.loadError}</p>
                        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshWorldEntries(draft.worldId)}>Try again</button>
                      </div>
                    ) : null}
                    {worldEntriesState.refreshError && (
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                        {worldEntriesState.refreshError}
                        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshWorldEntries(draft.worldId)}>Retry</button>
                      </p>
                    )}
                    {worldEntriesState.items === undefined && !worldEntriesState.loadError && <p className="text-sm text-muted" role="status">Loading this world’s compendium…</p>}
                    {worldCharactersState.refreshError && (
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                        {worldCharactersState.refreshError}
                        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshWorldCharacters(draft.worldId)}>Retry</button>
                      </p>
                    )}

                    {groundingCount === null ? (
                      <p className="text-sm text-muted" role="status">The combined grounding count will appear when this world’s context is loaded.</p>
                    ) : (
                      <p className="text-sm font-medium tabular-nums" role="status" aria-live="polite">
                        Combined grounding: {groundingCount.toLocaleString()} / {GROUNDING_CHARACTER_LIMIT.toLocaleString()} characters
                      </p>
                    )}
                    {overLimit && (
                      <p className="text-sm text-muted" role="alert">
                        This content exceeds the 32,000-character grounding limit. Shorten the text or deselect characters or entries before starting.
                      </p>
                    )}
                  </section>

                  <section className="grid gap-4 rounded-xl border border-border bg-raised p-5">
                    <label className="grid gap-1.5 text-sm font-medium" htmlFor="campaign-situation">
                      Starting situation
                      <span className="text-sm font-normal text-muted">Review or edit the opening context for this campaign.</span>
                      <textarea id="campaign-situation" rows={4} value={draft.startingSituation} onChange={(event) => setDraft((current) => ({ ...current, startingSituation: event.target.value, situationEdited: true }))} className="min-h-28 resize-y rounded-lg border border-border bg-background px-3 py-2 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium" htmlFor="campaign-name">
                      Campaign name <span className="font-normal text-muted">Optional</span>
                      <input id="campaign-name" autoComplete="off" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={`A story in ${world?.name ?? "your world"}`} className="min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
                    </label>
                  </section>

                  {startError && <p className="text-sm text-muted" role="alert">{startError}</p>}
                  <footer className="flex flex-wrap items-center justify-between gap-4 border-bs border-border pbs-5">
                    <p className="max-w-lg text-sm text-muted">Other campaigns keep their own story, context, and progress.</p>
                    <button type="submit" disabled={!canBegin} className="pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90">
                      {starting ? "Starting…" : "Begin story"}<ArrowRight className="size-4" aria-hidden="true" />
                    </button>
                  </footer>
                </form>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
