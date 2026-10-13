import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Globe2, UserRound } from "lucide-react";
import type { Campaign, Session } from "../../shared/domain";
import { createCampaign } from "../lib/storyApi";
import { refreshPersonas, refreshWorlds, usePersonas, useWorlds } from "../lib/libraryCache";
import { AppHeader } from "./AppHeader";

type Draft = {
  worldId: string;
  personaId: string;
  name: string;
  startingSituation: string;
  situationEdited: boolean;
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
      const situationChanged = (worldSeedChanged || nextWorldId !== current.worldId) && !current.situationEdited;
      return {
        ...current,
        worldId: nextWorldId,
        personaId: nextPersonaId,
        startingSituation: situationChanged
          ? worlds.find((item) => item.id === nextWorldId)?.suggested_starting_situation ?? ""
          : current.startingSituation,
      };
    });
  }, [worlds, personas, props.selectedPersonaId, props.selectedWorldId]);

  const world = worlds?.find((item) => item.id === draft.worldId);
  const persona = personas?.find((item) => item.id === draft.personaId);
  const canBegin = Boolean(world && persona && !starting);
  const coldLoadError = (worlds === undefined ? worldsState.loadError : undefined)
    ?? (personas === undefined ? personasState.loadError : undefined);
  const refreshError = worldsState.refreshError ?? personasState.refreshError;

  const chooseWorld = (id: string) => {
    const next = worlds?.find((item) => item.id === id);
    setDraft((current) => ({
      ...current,
      worldId: id,
      startingSituation: current.situationEdited
        ? current.startingSituation
        : next?.suggested_starting_situation ?? "",
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
