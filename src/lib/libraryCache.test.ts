import { describe, expect, mock, test } from "bun:test";
import type { LibrarySnapshot } from "./libraryCache";
import type { Persona, World } from "../../shared/domain";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

// Promise.withResolvers needs lib ES2024; this repo pins lib ES2022.
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const worldReads: Array<Deferred<World[]>> = [];
const personaReads: Array<Deferred<Persona[]>> = [];

mock.module("./storyApi", () => ({
  fetchWorlds: () => {
    const read = deferred<World[]>();
    worldReads.push(read);
    return read.promise;
  },
  fetchPersonas: () => {
    const read = deferred<Persona[]>();
    personaReads.push(read);
    return read.promise;
  },
}));

// Static import would evaluate libraryCache before mock.module registers, so the
// reads below must intercept storyApi first.
const { personasLibrary, refreshWorlds, warmLibraries, worldsLibrary } = await import("./libraryCache");

function world(id: string): World {
  return {
    id,
    name: `World ${id}`,
    setting_brief: "",
    suggested_starting_situation: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function persona(id: string): Persona {
  return {
    id,
    name: `Persona ${id}`,
    description: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function latestRead<T>(queue: Array<Deferred<T>>): Deferred<T> {
  const read = queue[queue.length - 1];
  if (!read) throw new Error("expected a pending read");
  return read;
}

function itemIds<T extends { id: string }>(snapshot: LibrarySnapshot<T>): string[] {
  return (snapshot.items ?? []).map((item) => item.id);
}

function waitFor<T>(
  library: { getSnapshot: () => LibrarySnapshot<T>; subscribe: (listener: () => void) => () => void },
  predicate: (snapshot: LibrarySnapshot<T>) => boolean,
): Promise<void> {
  let resolve!: () => void;
  const done = new Promise<void>((res) => {
    resolve = res;
  });
  let unsubscribe: (() => void) | undefined;
  const check = () => {
    if (!predicate(library.getSnapshot())) return;
    unsubscribe?.();
    resolve();
  };
  unsubscribe = library.subscribe(check);
  check();
  return done;
}

describe("worlds library", () => {
  test("starts unloaded, distinct from a loaded empty library", () => {
    const snapshot = worldsLibrary.getSnapshot();
    expect(snapshot.items).toBeUndefined();
    expect(snapshot.loading).toBeFalse();
    expect(snapshot.loadError).toBeUndefined();
    expect(snapshot.refreshError).toBeUndefined();
  });

  test("initial failure stays explicit; retry goes back to a pending read then succeeds", async () => {
    refreshWorlds();
    expect(worldsLibrary.getSnapshot().loading).toBeTrue();
    const failed = latestRead(worldReads);
    failed.reject(new Error("offline"));
    await waitFor(worldsLibrary, (snapshot) => snapshot.loadError === "offline");
    expect(worldsLibrary.getSnapshot().items).toBeUndefined();

    refreshWorlds();
    expect(worldsLibrary.getSnapshot().loadError).toBeUndefined();
    const retry = latestRead(worldReads);
    retry.resolve([world("w1")]);
    await retry.promise;
    await waitFor(worldsLibrary, (snapshot) => snapshot.items !== undefined);
    const snapshot = worldsLibrary.getSnapshot();
    expect(itemIds(snapshot)).toEqual(["w1"]);
    expect(snapshot.loadError).toBeUndefined();
    expect(snapshot.loading).toBeFalse();
  });

  test("failed revalidation keeps records; the notice holds until a successful full read", async () => {
    refreshWorlds();
    latestRead(worldReads).reject(new Error("still offline"));
    await waitFor(worldsLibrary, (snapshot) => snapshot.refreshError === "still offline");
    expect(itemIds(worldsLibrary.getSnapshot())).toEqual(["w1"]);

    refreshWorlds();
    const pending = worldsLibrary.getSnapshot();
    expect(pending.loading).toBeTrue();
    expect(pending.refreshError).toBe("still offline");
    const recovery = latestRead(worldReads);
    recovery.resolve([world("w1"), world("w2")]);
    await recovery.promise;
    await waitFor(worldsLibrary, (snapshot) => !snapshot.loading);
    const snapshot = worldsLibrary.getSnapshot();
    expect(snapshot.refreshError).toBeUndefined();
    expect(itemIds(snapshot)).toEqual(["w1", "w2"]);
  });

  test("overlapping reads apply only the latest response", async () => {
    refreshWorlds();
    refreshWorlds();
    const superseded = worldReads[worldReads.length - 2];
    const authoritative = latestRead(worldReads);
    authoritative.resolve([world("w2")]);
    await authoritative.promise;
    superseded.resolve([world("w-old")]);
    await superseded.promise;
    await waitFor(worldsLibrary, (snapshot) => !snapshot.loading);
    const snapshot = worldsLibrary.getSnapshot();
    expect(itemIds(snapshot)).toEqual(["w2"]);
    expect(snapshot.loading).toBeFalse();
  });

  test("save during a held read survives the stale response and reconciles the full list", async () => {
    refreshWorlds();
    const held = latestRead(worldReads);
    const saved = world("w-saved");
    worldsLibrary.applySaved(saved, undefined);
    expect(itemIds(worldsLibrary.getSnapshot())).toEqual(["w-saved", "w2"]);

    held.resolve([world("w-old")]);
    await held.promise;
    expect(itemIds(worldsLibrary.getSnapshot())).toContain("w-saved");

    const reconcile = latestRead(worldReads);
    expect(reconcile).not.toBe(held);
    reconcile.resolve([world("w2"), saved, world("w3")]);
    await reconcile.promise;
    await waitFor(worldsLibrary, (snapshot) => !snapshot.loading);
    expect(itemIds(worldsLibrary.getSnapshot())).toEqual(["w2", "w-saved", "w3"]);
  });

  test("edit replaces the cached record from the returned server record", () => {
    worldsLibrary.applySaved({ ...world("w2"), name: "Renamed" }, "w2");
    const snapshot = worldsLibrary.getSnapshot();
    expect(itemIds(snapshot)).toEqual(["w2", "w-saved", "w3"]);
    expect(snapshot.items?.[0]?.name).toBe("Renamed");
  });
});

describe("personas library", () => {
  test("warm loads unloaded libraries once and skips loaded or in-flight ones", () => {
    const worldsBefore = worldReads.length;
    warmLibraries();
    expect(worldReads.length).toBe(worldsBefore);
    expect(personaReads.length).toBe(1);
    warmLibraries();
    expect(personaReads.length).toBe(1);
  });

  test("save during the cold read survives the pre-save response and reconciles", async () => {
    const cold = latestRead(personaReads);
    const saved = persona("p-saved");
    personasLibrary.applySaved(saved, undefined);
    expect(itemIds(personasLibrary.getSnapshot())).toEqual(["p-saved"]);
    expect(personaReads.length).toBe(2);

    cold.resolve([]);
    await cold.promise;
    expect(itemIds(personasLibrary.getSnapshot())).toEqual(["p-saved"]);

    const reconcile = latestRead(personaReads);
    reconcile.resolve([persona("p0"), saved]);
    await reconcile.promise;
    await waitFor(personasLibrary, (snapshot) => !snapshot.loading);
    expect(itemIds(personasLibrary.getSnapshot())).toEqual(["p0", "p-saved"]);
  });

  test("warm skips libraries that already loaded", () => {
    const before = personaReads.length;
    warmLibraries();
    expect(personaReads.length).toBe(before);
  });
});
