import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Globe2, UserRound } from "lucide-react";
import type { Campaign, Session, WorldEntry, WorldEntryKind } from "../../shared/domain";
import { GROUNDING_CHARACTER_LIMIT, groundingCharacterCount } from "../../shared/grounding";
import { createCampaign } from "../lib/storyApi";
import { ensureWorldEntries, refreshPersonas, refreshWorldEntries, refreshWorlds, usePersonas, useWorldEntries, useWorlds } from "../lib/libraryCache";
import { AppHeader } from "./AppHeader";
import { worldEntryGroups } from "../lib/worldEntryGroups";

type Draft = {
  worldId: string;
  personaId: string;
  name: string;
  startingSituation: string;
  situationEdited: boolean;
  selectedEntryIds: string[];
};

export function NewCampaignPage(props: {
  onOpenSidebar: () => void;
  selectedWorldId: string | null;
  selectedPersonaId: string | null;
  onStarted: (campaign: Campaign, session: Session) => void;
}) {
  const worldsState = useWorlds();
  const personasState = usePersonas();
  const worlds = worldsState.items;
  const personas = personasState.items;
  const [draft, setDraft] = useState<Draft>({
    worldId: props.selectedWorldId ?? "",
    personaId: props.selectedPersonaId ?? "",
    name: "",
    startingSituation: "",
    situationEdited: false,
    selectedEntryIds: [],
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const seededWorldId = useRef<string | null | undefined>(undefined);
  const seededPersonaId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    refreshWorlds();
    refreshPersonas();
  }, []);

  useEffect(() => {
    if (worlds === undefined || personas === undefined) return;
    const worldSeedChanged = props.selectedWorldId !== seededWorldId.current;
    const personaSeedChanged = props.selectedPersonaId !== seededPersonaId.current;
    seededWorldId.current = props.selectedWorldId;
    seededPersonaId.current = props.selectedPersonaId;
    setDraft((current) => {
      const nextWorldId = worldSeedChanged && worlds.some((item) => item.id === props.selectedWorldId)
        ? props.selectedWorldId!
        : worlds.some((item) => item.id === current.worldId)
          ? current.worldId
          : worlds[0]?.id ?? "";
      const nextPersonaId = personaSeedChanged && personas.some((item) => item.id === props.selectedPersonaId)
        ? props.selectedPersonaId!
        : personas.some((item) => item.id === current.personaId)
          ? current.personaId
          : personas[0]?.id ?? "";
      const worldChanged = worldSeedChanged || nextWorldId !== current.worldId;
      const situationChanged = worldChanged && !current.situationEdited;
      return {
        ...current,
        worldId: nextWorldId,
        personaId: nextPersonaId,
        startingSituation: situationChanged
          ? worlds.find((item) => item.id === nextWorldId)?.suggested_starting_situation ?? ""
          : current.startingSituation,
        selectedEntryIds: worldChanged ? [] : current.selectedEntryIds,
      };
    });
  }, [worlds, personas, props.selectedPersonaId, props.selectedWorldId]);

  const world = worlds?.find((item) => item.id === draft.worldId);
  const persona = personas?.find((item) => item.id === draft.personaId);
  const worldEntriesState = useWorldEntries(draft.worldId);
  useEffect(() => {
    if (draft.worldId) ensureWorldEntries(draft.worldId);
  }, [draft.worldId]);

  const worldEntries = useMemo(
    () => [...(worldEntriesState.items ?? [])].sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [worldEntriesState.items],
  );
  const selectedEntries = worldEntries.filter((entry) =>
    entry.kind !== "scene" && draft.selectedEntryIds.includes(entry.id),
  );
  const groundingCount = world && persona
    ? groundingCharacterCount({
      world_name: world.name,
      world_setting_brief: world.setting_brief,
      persona_name: persona.name,
      persona_description: persona.description,
      starting_situation: draft.startingSituation.trim(),
      entries: selectedEntries,
    })
    : 0;
  const overLimit = groundingCount > GROUNDING_CHARACTER_LIMIT;
  const canBegin = Boolean(world && persona && !starting && !overLimit);
  const coldLoadError = (worlds === undefined ? worldsState.loadError : undefined)
    ?? (personas === undefined ? personasState.loadError : undefined);
  const refreshError = worldsState.refreshError ?? personasState.refreshError;

  const chooseWorld = (id: string) => {
    const next = worlds?.find((item) => item.id === id);
    setDraft((current) => ({
      ...current,
      worldId: id,
      selectedEntryIds: [],
      startingSituation: current.situationEdited
        ? current.startingSituation
        : next?.suggested_starting_situation ?? "",
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

  const toggleEntry = (entryId: string) => {
    setDraft((current) => ({
      ...current,
      selectedEntryIds: current.selectedEntryIds.includes(entryId)
        ? current.selectedEntryIds.filter((id) => id !== entryId)
        : [...current.selectedEntryIds, entryId],
    }));
  };

  const selectAll = (kind: Exclude<WorldEntryKind, "scene">) => {
    const ids = worldEntries.filter((entry) => entry.kind === kind).map((entry) => entry.id);
    setDraft((current) => ({
      ...current,
      selectedEntryIds: [...new Set([...current.selectedEntryIds, ...ids])],
    }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canBegin || !world || !persona) return;
    setStarting(true);
    setStartError("");
    try {
      const result = await createCampaign({
        world_id: world.id,
        persona_id: persona.id,
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

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="New campaign" onOpenSidebar={props.onOpenSidebar} />
      <div className="chat-scroll min-block-size-0 flex-1">
        <main className="mx-auto w-full max-w-4xl [padding-inline:clamp(1rem,0.75rem+1vw,2rem)] [padding-block:clamp(1.5rem,1.25rem+1vw,2rem)]">
          <header className="mbe-7 max-w-2xl">
            <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">A new playthrough</p>
            <h1 className="mbs-2 text-3xl font-semibold tracking-tight">Where will your story begin?</h1>
            <p className="mbs-2 text-sm leading-6 text-muted">Choose a world and persona. Your campaign captures both definitions and starts an independent timeline.</p>
          </header>

          {coldLoadError ? (
            <section className="grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
              <p className="text-sm text-muted">{coldLoadError}</p>
              <button
                type="button"
                className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                onClick={() => {
                  refreshWorlds();
                  refreshPersonas();
                }}
              >
                Try again
              </button>
            </section>
          ) : worlds === undefined || personas === undefined ? (
            <p className="py-8 text-sm text-muted" role="status">Loading your library…</p>
          ) : (
            <>
              {refreshError && (
                <p className="mbe-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                  {refreshError}
                  <button
                    type="button"
                    className="pressable min-h-11 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                    onClick={() => {
                      refreshWorlds();
                      refreshPersonas();
                    }}
                  >
                    Retry
                  </button>
                </p>
              )}
              {worlds.length === 0 || personas.length === 0 ? (
            <section className="grid justify-items-start gap-4 rounded-xl border border-dashed border-border p-6">
              <h2 className="text-lg font-semibold">Your story needs a world and a persona</h2>
              <p className="text-sm text-muted">Create both definitions before starting a campaign.</p>
              <div className="flex flex-wrap gap-2">
                {worlds.length === 0 && <Link className="pressable inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" to="/worlds">Create a world</Link>}
                {personas.length === 0 && <Link className="pressable inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" to="/personas">Create a persona</Link>}
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
                  <label htmlFor="campaign-persona" className="flex items-center gap-2 text-sm font-semibold"><UserRound className="size-4 text-accent" aria-hidden="true" />Playing as</label>
                  <select id="campaign-persona" className="min-h-11 rounded-lg border border-border bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" value={draft.personaId} onChange={(event) => setDraft((current) => ({ ...current, personaId: event.target.value }))}>
                    {personas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  {persona && <div className="rounded-lg bg-surface p-3"><p className="font-medium">{persona.name}</p><p className="mbs-1 whitespace-pre-wrap text-sm leading-6 text-muted">{persona.description}</p></div>}
                  <Link className="text-sm font-medium text-accent underline underline-offset-2" to="/personas">Browse or edit personas</Link>
                </section>
              </div>

              <section className="grid gap-5 rounded-xl border border-border bg-raised p-5" aria-labelledby="compendium-choice-title">
                <header>
                  <h2 id="compendium-choice-title" className="text-lg font-semibold">Choose compendium entries</h2>
                  <p className="mbs-1 text-sm leading-6 text-muted">Characters, locations, and lore start unselected. Choose only the details this campaign should know.</p>
                </header>

                {worldEntriesState.refreshError && (
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                    {worldEntriesState.refreshError}
                    <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => refreshWorldEntries(draft.worldId)}>Retry</button>
                  </p>
                )}

                {worldEntriesState.items === undefined && worldEntriesState.loadError ? (
                  <section className="grid justify-items-start gap-3 rounded-lg border border-border p-4" role="alert">
                    <p className="text-sm text-muted">{worldEntriesState.loadError}</p>
                    <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => refreshWorldEntries(draft.worldId)}>Try again</button>
                  </section>
                ) : worldEntriesState.items === undefined ? (
                  <p className="text-sm text-muted" role="status">Loading this world’s compendium…</p>
                ) : (
                  <>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-4">
                      {worldEntryGroups.map((group) => {
                        const kind = group.kind;
                        if (kind === "scene") return null;
                        const categoryEntries = worldEntries.filter((entry) => entry.kind === kind);
                        const selectedCount = categoryEntries.filter((entry) => draft.selectedEntryIds.includes(entry.id)).length;
                        return (
                          <fieldset key={kind} className="grid content-start gap-3 rounded-lg border border-border p-4">
                            <legend className="px-1 font-semibold">{group.label}</legend>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs text-muted">{selectedCount} of {categoryEntries.length} selected</p>
                              <button
                                type="button"
                                className="pressable min-h-9 rounded-lg border border-border px-3 text-xs font-medium [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
                                onClick={() => selectAll(kind)}
                                disabled={categoryEntries.length === 0}
                              >
                                Select all
                              </button>
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
                        <p className="mbs-1 text-sm text-muted">Use a scene to fill the starting situation. Scenes do not add separate compendium grounding.</p>
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
                              >
                                Use scene
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  </>
                )}

                <section className="grid gap-3 rounded-lg bg-surface p-4" aria-labelledby="included-compendium-title">
                  <div>
                    <h3 id="included-compendium-title" className="font-semibold">Included compendium preview</h3>
                    <p className="mbs-1 text-sm text-muted">Only selected characters, locations, and lore will be captured.</p>
                  </div>
                  {selectedEntries.length === 0 ? (
                    <p className="text-sm text-muted">No compendium entries selected.</p>
                  ) : (
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
                </section>

                <p className="text-sm font-medium tabular-nums" role="status" aria-live="polite">
                  Combined grounding: {groundingCount.toLocaleString()} / {GROUNDING_CHARACTER_LIMIT.toLocaleString()} characters
                </p>
                {overLimit && (
                  <p className="text-sm text-muted" role="alert">
                    This content exceeds the 32,000-character grounding limit. Shorten the text or deselect entries before starting.
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
