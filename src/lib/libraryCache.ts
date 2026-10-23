import { useSyncExternalStore } from "react";
import type { Character, World, WorldEntry } from "../../shared/domain";
import { fetchCharacters, fetchWorlds, listWorldCharacters, listWorldEntries } from "./storyApi";

export type LibrarySnapshot<T> = {
  /** undefined until the first read completes; an empty array is a real, loaded library */
  items: T[] | undefined;
  loading: boolean;
  loadError: string | undefined;
  refreshError: string | undefined;
};

export type Library<T> = {
  getSnapshot: () => LibrarySnapshot<T>;
  subscribe: (listener: () => void) => () => void;
  load: () => Promise<void>;
  applySaved: (saved: T, previousId: string | undefined) => void;
  applyRemoved: (id: string) => void;
};

export function createLibrary<T>(
  fetchItems: () => Promise<T[]>,
  unavailableMessage: string,
  keyOf: (item: T) => string = (item) => {
    if (typeof item === "object" && item !== null && "id" in item) return String(item.id);
    throw new Error("Libraries without item ids require a key selector.");
  },
): Library<T> {
  let snapshot: LibrarySnapshot<T> = {
    items: undefined,
    loading: false,
    loadError: undefined,
    refreshError: undefined,
  };
  let sequence = 0;
  const listeners = new Set<() => void>();

  const commit = (next: LibrarySnapshot<T>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const load = async () => {
    const requestId = ++sequence;
    // A failed read over cached records keeps its notice while the next read is pending;
    // only a successful full read clears it.
    commit({
      items: snapshot.items,
      loading: true,
      loadError: undefined,
      refreshError: snapshot.refreshError,
    });
    try {
      const items = await fetchItems();
      if (sequence !== requestId) return;
      commit({ items, loading: false, loadError: undefined, refreshError: undefined });
    } catch (error) {
      if (sequence !== requestId) return;
      const message = error instanceof Error ? error.message : unavailableMessage;
      if (snapshot.items === undefined) {
        commit({ ...snapshot, loading: false, loadError: message });
      } else {
        commit({ ...snapshot, loading: false, refreshError: message });
      }
    }
  };

  const applySaved = (saved: T, previousId: string | undefined) => {
    const items = snapshot.items;
    const nextItems = previousId
      ? items?.map((item) => (keyOf(item) === previousId ? saved : item))
      : items === undefined
        ? [saved]
        : [saved, ...items];
    // A read started before this save may resolve without it (and a cold library has no
    // authoritative full list yet), so discard it and reconcile with a fresh read.
    const needsReconcile = snapshot.loading || items === undefined;
    commit({
      items: nextItems,
      loading: needsReconcile,
      loadError: undefined,
      refreshError: snapshot.refreshError,
    });
    if (needsReconcile) void load();
  };

  const applyRemoved = (id: string) => {
    const items = snapshot.items;
    const needsReconcile = snapshot.loading || items === undefined;
    commit({
      items: items?.filter((item) => keyOf(item) !== id),
      loading: needsReconcile,
      loadError: undefined,
      refreshError: snapshot.refreshError,
    });
    if (needsReconcile) void load();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    applySaved,
    applyRemoved,
  };
}

export const worldsLibrary = createLibrary<World>(fetchWorlds, "Could not load worlds.");
export const charactersLibrary = createLibrary<Character>(fetchCharacters, "Could not load characters.");

const worldEntryLibraries = new Map<string, Library<WorldEntry>>();
const worldCharacterLibraries = new Map<string, Library<Character>>();

function getWorldEntriesLibrary(worldId: string): Library<WorldEntry> {
  let library = worldEntryLibraries.get(worldId);
  if (!library) {
    library = createLibrary(
      () => listWorldEntries(worldId),
      "Could not load this world's compendium.",
    );
    worldEntryLibraries.set(worldId, library);
  }
  return library;
}

function getWorldCharactersLibrary(worldId: string): Library<Character> {
  let library = worldCharacterLibraries.get(worldId);
  if (!library) {
    library = createLibrary(
      () => listWorldCharacters(worldId),
      "Could not load this world's characters.",
    );
    worldCharacterLibraries.set(worldId, library);
  }
  return library;
}

export function useWorldEntries(worldId: string): LibrarySnapshot<WorldEntry> {
  const library = getWorldEntriesLibrary(worldId);
  return useSyncExternalStore(library.subscribe, library.getSnapshot);
}

export function ensureWorldEntries(worldId: string): void {
  const library = getWorldEntriesLibrary(worldId);
  const snapshot = library.getSnapshot();
  if (snapshot.items === undefined && !snapshot.loading) void library.load();
}

export function refreshWorldEntries(worldId: string): void {
  void getWorldEntriesLibrary(worldId).load();
}

export function applyWorldEntrySaved(
  worldId: string,
  saved: WorldEntry,
  previousId?: string,
): void {
  getWorldEntriesLibrary(worldId).applySaved(saved, previousId);
}

export function applyWorldEntryRemoved(worldId: string, entryId: string): void {
  getWorldEntriesLibrary(worldId).applyRemoved(entryId);
}

export function useWorldCharacters(worldId: string): LibrarySnapshot<Character> {
  const library = getWorldCharactersLibrary(worldId);
  return useSyncExternalStore(library.subscribe, library.getSnapshot);
}

export function ensureWorldCharacters(worldId: string): void {
  const library = getWorldCharactersLibrary(worldId);
  const snapshot = library.getSnapshot();
  if (snapshot.items === undefined && !snapshot.loading) void library.load();
}

export function refreshWorldCharacters(worldId: string): void {
  void getWorldCharactersLibrary(worldId).load();
}

export function applyWorldCharacterSaved(
  worldId: string,
  saved: Character,
  previousId?: string,
): void {
  getWorldCharactersLibrary(worldId).applySaved(saved, previousId);
}

export function applyWorldCharacterRemoved(worldId: string, characterId: string): void {
  getWorldCharactersLibrary(worldId).applyRemoved(characterId);
}

export function useWorlds(): LibrarySnapshot<World> {
  return useSyncExternalStore(worldsLibrary.subscribe, worldsLibrary.getSnapshot);
}

export function useCharacters(): LibrarySnapshot<Character> {
  return useSyncExternalStore(charactersLibrary.subscribe, charactersLibrary.getSnapshot);
}

export function refreshWorlds(): void {
  void worldsLibrary.load();
}

export function refreshCharacters(): void {
  void charactersLibrary.load();
}

/** Loads each library once per app lifetime; skips anything already loaded or loading. */
export function warmLibraries(): void {
  const worlds = worldsLibrary.getSnapshot();
  if (worlds.items === undefined && !worlds.loading) refreshWorlds();
  const characters = charactersLibrary.getSnapshot();
  if (characters.items === undefined && !characters.loading) refreshCharacters();
}

export function refreshLibraries(): void {
  refreshWorlds();
  refreshCharacters();
}
