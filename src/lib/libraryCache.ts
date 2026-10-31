import { useSyncExternalStore } from "react";
import type { Chat, Character, Relationship, ScratchMessage, StatDefinition, World, WorldEntry } from "../../shared/domain";
import { fetchChats, fetchScratchpad, fetchStats, fetchWorlds, fetchWorldChats, fetchWorldRelationships, fetchWorldStats, listWorldCharacters, listWorldEntries } from "./storyApi";

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
export const chatsLibrary = createLibrary<Chat>(fetchChats, "Could not load chats.");
export const statsLibrary = createLibrary<StatDefinition>(fetchStats, "Could not load stats.");

const worldEntryLibraries = new Map<string, Library<WorldEntry>>();
const worldCharacterLibraries = new Map<string, Library<Character>>();
const worldStatLibraries = new Map<string, Library<StatDefinition>>();
const worldRelationshipLibraries = new Map<string, Library<Relationship>>();
const worldChatLibraries = new Map<string, Library<Chat>>();
const scratchpadLibraries = new Map<string, Library<ScratchMessage>>();

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

function getWorldStatsLibrary(worldId: string): Library<StatDefinition> {
  let library = worldStatLibraries.get(worldId);
  if (!library) {
    library = createLibrary(
      () => fetchWorldStats(worldId),
      "Could not load this world's stats.",
    );
    worldStatLibraries.set(worldId, library);
  }
  return library;
}

function getWorldRelationshipsLibrary(worldId: string): Library<Relationship> {
  let library = worldRelationshipLibraries.get(worldId);
  if (!library) {
    library = createLibrary(
      () => fetchWorldRelationships(worldId),
      "Could not load this world's relationships.",
    );
    worldRelationshipLibraries.set(worldId, library);
  }
  return library;
}

function getWorldChatsLibrary(worldId: string): Library<Chat> {
  let library = worldChatLibraries.get(worldId);
  if (!library) {
    library = createLibrary(
      () => fetchWorldChats(worldId),
      "Could not load this world's chats.",
    );
    worldChatLibraries.set(worldId, library);
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

export function useWorldStats(worldId: string): LibrarySnapshot<StatDefinition> {
  const library = getWorldStatsLibrary(worldId);
  return useSyncExternalStore(library.subscribe, library.getSnapshot);
}

export function ensureWorldStats(worldId: string): void {
  const library = getWorldStatsLibrary(worldId);
  const snapshot = library.getSnapshot();
  if (snapshot.items === undefined && !snapshot.loading) void library.load();
}

export function refreshWorldStats(worldId: string): void {
  void getWorldStatsLibrary(worldId).load();
}

export function applyWorldStatSaved(
  worldId: string,
  saved: StatDefinition,
  previousId?: string,
): void {
  getWorldStatsLibrary(worldId).applySaved(saved, previousId);
}

export function applyWorldStatRemoved(worldId: string, statId: string): void {
  getWorldStatsLibrary(worldId).applyRemoved(statId);
}

export function useWorlds(): LibrarySnapshot<World> {
  return useSyncExternalStore(worldsLibrary.subscribe, worldsLibrary.getSnapshot);
}

export function useWorldRelationships(worldId: string): LibrarySnapshot<Relationship> {
  const library = getWorldRelationshipsLibrary(worldId);
  return useSyncExternalStore(library.subscribe, library.getSnapshot);
}

export function ensureWorldRelationships(worldId: string): void {
  const library = getWorldRelationshipsLibrary(worldId);
  const snapshot = library.getSnapshot();
  if (snapshot.items === undefined && !snapshot.loading) void library.load();
}

export function refreshWorldRelationships(worldId: string): void {
  void getWorldRelationshipsLibrary(worldId).load();
}

export function applyWorldRelationshipSaved(worldId: string, saved: Relationship, previousId?: string): void {
  getWorldRelationshipsLibrary(worldId).applySaved(saved, previousId);
}

export function applyWorldRelationshipRemoved(worldId: string, relationshipId: string): void {
  getWorldRelationshipsLibrary(worldId).applyRemoved(relationshipId);
}

export function useWorldChats(worldId: string): LibrarySnapshot<Chat> {
  const library = getWorldChatsLibrary(worldId);
  return useSyncExternalStore(library.subscribe, library.getSnapshot);
}

export function refreshWorldChats(worldId: string): void {
  void getWorldChatsLibrary(worldId).load();
}

function getScratchpadLibrary(chatId: string): Library<ScratchMessage> {
  let library = scratchpadLibraries.get(chatId);
  if (!library) {
    library = createLibrary(() => fetchScratchpad(chatId), "Could not load the scratchpad.");
    scratchpadLibraries.set(chatId, library);
  }
  return library;
}

/** A chat's scratchpad thread, in position order. */
export function useScratchpad(chatId: string): LibrarySnapshot<ScratchMessage> {
  const library = getScratchpadLibrary(chatId);
  return useSyncExternalStore(library.subscribe, library.getSnapshot);
}

export function refreshScratchpad(chatId: string): Promise<void> {
  return getScratchpadLibrary(chatId).load();
}

export function useChats(): LibrarySnapshot<Chat> {
  return useSyncExternalStore(chatsLibrary.subscribe, chatsLibrary.getSnapshot);
}

export function refreshChats(): void {
  void chatsLibrary.load();
}

/** A stat change reaches every character and relationship of the world. */
export function refreshWorldStatDependents(worldId: string): void {
  refreshWorldStats(worldId);
  refreshWorldCharacters(worldId);
  refreshWorldRelationships(worldId);
}

/** Re-reads everything a world-editing surface shows; used when the window regains focus. */
export function refreshWorldData(worldId: string): void {
  refreshWorldEntries(worldId);
  refreshWorldStatDependents(worldId);
}

export function refreshWorlds(): void {
  void worldsLibrary.load();
}

export function useStats(): LibrarySnapshot<StatDefinition> {
  return useSyncExternalStore(statsLibrary.subscribe, statsLibrary.getSnapshot);
}

export function refreshStats(): void {
  void statsLibrary.load();
}

export function applyStatSaved(saved: StatDefinition, previousId?: string): void {
  statsLibrary.applySaved(saved, previousId);
}

export function applyStatRemoved(statId: string): void {
  statsLibrary.applyRemoved(statId);
}

/** Loads each library once per app lifetime; skips anything already loaded or loading. */
export function warmLibraries(): void {
  const worlds = worldsLibrary.getSnapshot();
  if (worlds.items === undefined && !worlds.loading) refreshWorlds();
  const chats = chatsLibrary.getSnapshot();
  if (chats.items === undefined && !chats.loading) refreshChats();
}

export function refreshLibraries(): void {
  refreshWorlds();
  refreshChats();
}
