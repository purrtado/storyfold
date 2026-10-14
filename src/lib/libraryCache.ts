import { useSyncExternalStore } from "react";
import type { Persona, World, WorldEntry } from "../../shared/domain";
import { fetchPersonas, fetchWorlds, listWorldEntries } from "./storyApi";

export type LibrarySnapshot<T> = {
  /** undefined until the first read completes; an empty array is a real, loaded library */
  items: T[] | undefined;
  loading: boolean;
  loadError: string | undefined;
  refreshError: string | undefined;
};

export type Library<T extends { id: string }> = {
  getSnapshot: () => LibrarySnapshot<T>;
  subscribe: (listener: () => void) => () => void;
  load: () => Promise<void>;
  applySaved: (saved: T, previousId: string | undefined) => void;
  applyRemoved: (id: string) => void;
};

export function createLibrary<T extends { id: string }>(
  fetchItems: () => Promise<T[]>,
  unavailableMessage: string,
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
      ? items?.map((item) => (item.id === previousId ? saved : item))
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
      items: items?.filter((item) => item.id !== id),
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
export const personasLibrary = createLibrary<Persona>(fetchPersonas, "Could not load personas.");

const worldEntryLibraries = new Map<string, Library<WorldEntry>>();

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

export function useWorlds(): LibrarySnapshot<World> {
  return useSyncExternalStore(worldsLibrary.subscribe, worldsLibrary.getSnapshot);
}

export function usePersonas(): LibrarySnapshot<Persona> {
  return useSyncExternalStore(personasLibrary.subscribe, personasLibrary.getSnapshot);
}

export function refreshWorlds(): void {
  void worldsLibrary.load();
}

export function refreshPersonas(): void {
  void personasLibrary.load();
}

/** Loads each library once per app lifetime; skips anything already loaded or loading. */
export function warmLibraries(): void {
  const worlds = worldsLibrary.getSnapshot();
  if (worlds.items === undefined && !worlds.loading) refreshWorlds();
  const personas = personasLibrary.getSnapshot();
  if (personas.items === undefined && !personas.loading) refreshPersonas();
}

export function refreshLibraries(): void {
  refreshWorlds();
  refreshPersonas();
}
