import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, ChevronLeft, MessageSquare, Pencil, Trash2 } from "lucide-react";
import type { Chat, World } from "../../shared/domain";
import {
  ensureWorldCharacters,
  refreshChats,
  refreshWorldChats,
  refreshWorldData,
  useWorldCharacters,
  useWorldChats,
  useWorldEntries,
  useWorlds,
  worldsLibrary,
  ensureWorldEntries,
} from "../lib/libraryCache";
import { createChat, deleteChat, renameChat, updateWorld } from "../lib/storyApi";
import { AppHeader } from "./AppHeader";
import { CharacterRoster } from "./CharacterRoster";
import { TextEditor } from "./TextEditor";
import { WorldCompendium } from "./WorldCompendium";
import { WorldStats } from "./WorldStats";

const fieldClass = "min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const sectionClass = "grid gap-4 rounded-xl border border-border bg-raised p-5";
const eyebrowClass = "text-xs font-semibold tracking-[0.12em] text-muted uppercase";
const secondaryButton = "pressable inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface disabled:pointer-events-none disabled:opacity-50";
const primaryButton = "pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg disabled:cursor-wait disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90";

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function BriefSection(props: { world: World }) {
  const [name, setName] = useState(props.world.name);
  const [brief, setBrief] = useState(props.world.setting_brief);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const dirty = name.trim() !== props.world.name || brief.trim() !== props.world.setting_brief;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (!brief.trim()) {
      setError("Add a setting brief.");
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const updated = await updateWorld(props.world.id, { name: name.trim(), setting_brief: brief.trim() });
      worldsLibrary.applySaved(updated, props.world.id);
      setName(updated.name);
      setBrief(updated.setting_brief);
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught, "Could not save this world."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={sectionClass} aria-labelledby="world-brief-title">
      <header>
        <p className={eyebrowClass}>Setting</p>
        <h2 id="world-brief-title" className="mbs-1 text-lg font-semibold">World brief</h2>
        <p className="mbs-1 max-w-2xl text-sm leading-6 text-muted">The narrator reads this in every chat. Changes apply from the next reply.</p>
      </header>
      <form className="grid gap-4" onSubmit={(event) => { void submit(event); }}>
        <label className="grid gap-1.5 text-sm font-medium">
          Name
          <input
            required
            autoComplete="off"
            value={name}
            onChange={(event) => { setName(event.target.value); setSaved(false); }}
            className={fieldClass}
          />
        </label>
        <div className="grid gap-1.5 text-sm font-medium">
          <span id="hub-setting-brief">Setting brief</span>
          <TextEditor
            labelledBy="hub-setting-brief"
            value={brief}
            onChange={(value) => { setBrief(value); setSaved(false); }}
            className="min-h-28 rounded-lg border border-border bg-background font-normal"
          />
        </div>
        {error && <p className="text-sm text-muted" role="alert">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={primaryButton} disabled={!dirty || saving}>{saving ? "Saving…" : "Save brief"}</button>
          {saved && !dirty && <p className="text-sm text-muted" role="status">Saved.</p>}
        </div>
      </form>
    </section>
  );
}

function NewChatForm(props: { world: World; chats: Chat[] }) {
  const navigate = useNavigate();
  const charactersLibrary = useWorldCharacters(props.world.id);
  const entriesLibrary = useWorldEntries(props.world.id);
  const characters = useMemo(
    () => [...(charactersLibrary.items ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [charactersLibrary.items],
  );
  const scenes = useMemo(
    () => (entriesLibrary.items ?? [])
      .filter((entry) => entry.kind === "scene")
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [entriesLibrary.items],
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [opening, setOpening] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const lastProtagonistId = props.chats[0]?.protagonist_id;
  const protagonistId = characters.some((character) => character.id === chosenId)
    ? chosenId!
    : characters.some((character) => character.id === lastProtagonistId)
      ? lastProtagonistId!
      : characters[0]?.id ?? "";
  const protagonist = characters.find((character) => character.id === protagonistId);

  const applyScene = (description: string) => {
    if (opening.trim() && opening.trim() !== description.trim() && !window.confirm("Replace the opening you wrote with this scene?")) return;
    setOpening(description);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!protagonist || starting) return;
    setStarting(true);
    setError("");
    try {
      const chat = await createChat(props.world.id, {
        protagonist_id: protagonist.id,
        ...(opening.trim() ? { opening: opening.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      refreshChats();
      refreshWorldChats(props.world.id);
      navigate(`/chats/${encodeURIComponent(chat.id)}`);
    } catch (caught) {
      setError(errorMessage(caught, "Could not start this chat."));
      setStarting(false);
    }
  };

  return (
    <section className={sectionClass} aria-labelledby="new-chat-title">
      <header>
        <p className={eyebrowClass}>A new playthrough</p>
        <h2 id="new-chat-title" className="mbs-1 text-lg font-semibold">New chat</h2>
        <p className="mbs-1 max-w-2xl text-sm leading-6 text-muted">A chat is one playthrough of {props.world.name}. It reads the world live and never changes it.</p>
      </header>
      {charactersLibrary.items === undefined ? (
        charactersLibrary.loadError ? (
          <div className="grid justify-items-start gap-2" role="alert">
            <p className="text-sm text-muted">{charactersLibrary.loadError}</p>
            <button type="button" className={secondaryButton} onClick={() => ensureWorldCharacters(props.world.id)}>Try again</button>
          </div>
        ) : <p className="text-sm text-muted" role="status">Loading this world’s characters…</p>
      ) : characters.length === 0 ? (
        <p className="text-sm text-muted">Add a character to {props.world.name} below, then start a chat as them.</p>
      ) : (
        <form className="grid gap-4" onSubmit={(event) => { void submit(event); }}>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4">
            <label className="grid content-start gap-1.5 text-sm font-medium">
              Playing as
              <select className={fieldClass} value={protagonistId} onChange={(event) => setChosenId(event.target.value)}>
                {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
              </select>
            </label>
            <label className="grid content-start gap-1.5 text-sm font-medium">
              Title <span className="font-normal text-muted">Optional</span>
              <input
                autoComplete="off"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Defaults to the opening’s first line"
                className={fieldClass}
              />
            </label>
          </div>
          {scenes.length > 0 && (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Opening scenes <span className="font-normal text-muted">Use one to fill the opening</span></p>
              <ul className="flex list-none flex-wrap gap-2 p-0">
                {scenes.map((scene) => (
                  <li key={scene.id}>
                    <button
                      type="button"
                      className={secondaryButton}
                      title={scene.description}
                      aria-label={`Use ${scene.name} as the opening`}
                      onClick={() => applyScene(scene.description)}
                    >
                      {scene.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="grid gap-1.5 text-sm font-medium">
            Opening <span className="font-normal text-muted">Optional. How the story starts; the narrator reads it until the chat has narration.</span>
            <textarea
              rows={4}
              value={opening}
              onChange={(event) => setOpening(event.target.value)}
              className="min-h-28 resize-y rounded-lg border border-border bg-background px-3 py-2 text-base font-normal leading-6 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          </label>
          {error && <p className="text-sm text-muted" role="alert">{error}</p>}
          <div>
            <button type="submit" className={primaryButton} disabled={!protagonist || starting}>
              {starting ? "Starting…" : "Start chat"}<ArrowRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ChatRow(props: { chat: Chat; protagonistName: string; onChanged: () => void }) {
  const { chat } = props;
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = title.trim();
    if (!next || busy) return;
    setBusy(true);
    setError("");
    try {
      await renameChat(chat.id, next);
      setRenaming(false);
      props.onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Could not rename this chat."));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await deleteChat(chat.id);
      props.onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Could not discard this chat."));
      setBusy(false);
    }
  };

  return (
    <li className="grid gap-2 border-bs border-border pbs-3 first:border-0 first:pbs-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {renaming ? (
          <form className="flex min-w-0 flex-1 flex-wrap items-center gap-2" onSubmit={(event) => { void rename(event); }}>
            <input
              required
              autoFocus
              autoComplete="off"
              aria-label="Chat title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={`${fieldClass} min-w-0 flex-1`}
            />
            <button type="submit" className={secondaryButton} disabled={busy || !title.trim()}>Save</button>
            <button type="button" className={secondaryButton} onClick={() => { setRenaming(false); setTitle(chat.title); }} disabled={busy}>Cancel</button>
          </form>
        ) : (
          <Link to={`/chats/${encodeURIComponent(chat.id)}`} className="grid min-w-0 flex-1 gap-0.5 no-underline">
            <span className="flex items-center gap-2 font-medium text-foreground">
              <MessageSquare className="size-4 flex-none text-accent" aria-hidden="true" />
              <span className="min-w-0 truncate">{chat.title}</span>
            </span>
            <span className="truncate ps-6 text-xs text-muted">{props.protagonistName ? `As ${props.protagonistName} · ` : ""}Updated {formatDate(chat.updated_at)}</span>
          </Link>
        )}
        {!renaming && (
          <div className="flex flex-none items-center gap-1">
            <button
              type="button"
              className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              aria-label={`Rename ${chat.title}`}
              onClick={() => { setTitle(chat.title); setRenaming(true); }}
              disabled={busy}
            ><Pencil className="size-4" aria-hidden="true" /></button>
            <button
              type="button"
              className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              aria-label={`Discard ${chat.title}`}
              onClick={() => setConfirmDiscard(true)}
              disabled={busy}
            ><Trash2 className="size-4" aria-hidden="true" /></button>
          </div>
        )}
      </div>
      {confirmDiscard && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3" role="group" aria-label={`Confirm discarding ${chat.title}`}>
          <p className="min-w-0 flex-1 text-sm text-muted">Discard this chat? Its transcript is deleted; the world is unchanged.</p>
          <button type="button" className={secondaryButton} onClick={() => { void discard(); }} disabled={busy}>{busy ? "Discarding…" : "Discard chat"}</button>
          <button type="button" className={secondaryButton} onClick={() => setConfirmDiscard(false)} disabled={busy}>Cancel</button>
        </div>
      )}
      {error && <p className="text-sm text-muted" role="alert">{error}</p>}
    </li>
  );
}

function ChatList(props: { world: World }) {
  const library = useWorldChats(props.world.id);
  const characters = useWorldCharacters(props.world.id).items ?? [];
  const chats = library.items;

  const changed = () => {
    refreshWorldChats(props.world.id);
    refreshChats();
  };

  return (
    <section className={sectionClass} aria-labelledby="world-chats-title">
      <header>
        <p className={eyebrowClass}>Playthroughs</p>
        <h2 id="world-chats-title" className="mbs-1 text-lg font-semibold">Chats</h2>
      </header>
      {chats === undefined ? (
        library.loadError ? (
          <div className="grid justify-items-start gap-2" role="alert">
            <p className="text-sm text-muted">{library.loadError}</p>
            <button type="button" className={secondaryButton} onClick={() => refreshWorldChats(props.world.id)}>Try again</button>
          </div>
        ) : <p className="text-sm text-muted" role="status">Loading chats…</p>
      ) : chats.length === 0 ? (
        <p className="text-sm text-muted">No chats in {props.world.name} yet. Start one above.</p>
      ) : (
        <ul className="grid list-none gap-3 p-0">
          {chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              protagonistName={characters.find((character) => character.id === chat.protagonist_id)?.name ?? ""}
              onChanged={changed}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function WorldHub(props: { worldId: string; onOpenSidebar: () => void }) {
  const worldsState = useWorlds();
  const world = worldsState.items?.find((item) => item.id === props.worldId);
  const chatsState = useWorldChats(props.worldId);
  const [openCharacterId, setOpenCharacterId] = useState<string | null>(null);
  const chats = useMemo(
    () => [...(chatsState.items ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [chatsState.items],
  );

  useEffect(() => {
    ensureWorldCharacters(props.worldId);
    ensureWorldEntries(props.worldId);
    refreshWorldChats(props.worldId);
    const onFocus = () => {
      refreshWorldData(props.worldId);
      refreshWorldChats(props.worldId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [props.worldId]);

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title={world?.name ?? "World"} onOpenSidebar={props.onOpenSidebar} />
      <div className="chat-scroll min-block-size-0 flex-1">
        <main className="mx-auto grid w-full max-w-5xl gap-6 [padding-inline:clamp(1rem,0.75rem+1vw,2rem)] [padding-block:clamp(1.5rem,1.25rem+1vw,2rem)]">
          <Link to="/worlds" className="inline-flex w-fit items-center gap-1 text-sm text-muted no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground">
            <ChevronLeft className="size-4" aria-hidden="true" />All worlds
          </Link>
          {worldsState.items === undefined ? (
            worldsState.loadError ? (
              <section className="grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
                <p className="text-sm text-muted">{worldsState.loadError}</p>
                <button type="button" className={secondaryButton} onClick={() => { void worldsLibrary.load(); }}>Try again</button>
              </section>
            ) : <p className="py-8 text-sm text-muted" role="status">Loading world…</p>
          ) : !world ? (
            <section className="grid justify-items-start gap-3 rounded-xl border border-border p-6" role="alert">
              <p className="text-sm text-muted">This world no longer exists.</p>
              <Link to="/worlds" className={secondaryButton}>Back to worlds</Link>
            </section>
          ) : (
            <>
              <header className="max-w-2xl">
                <p className={eyebrowClass}>World</p>
                <h1 className="mbs-2 text-3xl font-semibold tracking-tight">{world.name}</h1>
                <p className="mbs-2 text-sm leading-6 text-muted">This world is the save: every chat reads it live, and edits here reach the narrator from the next reply.</p>
              </header>
              <NewChatForm world={world} chats={chats} />
              <ChatList world={world} />
              <BriefSection key={`${world.id}:${world.updated_at}`} world={world} />
              <section className={sectionClass} aria-labelledby="world-characters-title">
                <header>
                  <p className={eyebrowClass}>Cast</p>
                  <h2 id="world-characters-title" className="mbs-1 text-lg font-semibold">Characters and relationships</h2>
                  <p className="mbs-1 max-w-2xl text-sm leading-6 text-muted">Anyone here can be the protagonist of a chat; everyone else reaches the narrator by their context mode.</p>
                </header>
                <CharacterRoster world={world} openId={openCharacterId} onOpenChange={setOpenCharacterId} />
              </section>
              <WorldCompendium world={world} />
              <WorldStats world={world} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
