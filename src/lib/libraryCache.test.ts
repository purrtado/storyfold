import { describe, expect, test } from "bun:test";
import { createLibrary, type Library, type LibrarySnapshot } from "./libraryCache";
import type { Character, World } from "../../shared/domain";

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

function world(id: string, name: string): World {
  return {
    id,
    name,
    setting_brief: `${name} stretches between a drowned harbor and stubborn hill farms.`,
    suggested_starting_situation: `The caravan reaches ${name} at dusk with one wagon axle cracked.`,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function character(id: string, name: string): Character {
  return {
    id,
    name,
    description: `${name} is a cautious cartographer who trusts neither maps nor their makers.`,
    appearance: "",
    personality: "",
    background: "",
    baseline_motivations: "",
    speaking_style: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function trackedLibrary<T extends { id: string }>(
  reads: Array<Deferred<T[]>>,
  unavailableMessage: string,
): Library<T> {
  return createLibrary<T>(() => {
    const read = deferred<T[]>();
    reads.push(read);
    return read.promise;
  }, unavailableMessage);
}

function latestRead<T>(reads: Array<Deferred<T>>): Deferred<T> {
  const read = reads[reads.length - 1];
  if (!read) throw new Error("expected a pending read");
  return read;
}

function itemIds<T extends { id: string }>(snapshot: LibrarySnapshot<T>): string[] {
  return (snapshot.items ?? []).map((item) => item.id);
}

describe("library cache", () => {
  test("moves from unloaded through a loaded empty library to loaded records", async () => {
    const reads: Array<Deferred<World[]>> = [];
    const library = trackedLibrary<World>(reads, "Could not load worlds.");
    expect(library.getSnapshot().items).toBeUndefined();

    const emptyLoad = library.load();
    latestRead(reads).resolve([]);
    await emptyLoad;
    const empty = library.getSnapshot();
    expect(empty.items).toEqual([]);
    expect(empty.loading).toBeFalse();

    const fullLoad = library.load();
    latestRead(reads).resolve([world("w1", "Midgard")]);
    await fullLoad;
    expect(itemIds(library.getSnapshot())).toEqual(["w1"]);
  });

  test("keeps an initial failure explicit until a retry succeeds", async () => {
    const reads: Array<Deferred<World[]>> = [];
    const library = trackedLibrary<World>(reads, "Could not load worlds.");

    const failedLoad = library.load();
    latestRead(reads).reject(new Error("offline"));
    await failedLoad;
    const failed = library.getSnapshot();
    expect(failed.items).toBeUndefined();
    expect(failed.loadError).not.toBeUndefined();
    expect(failed.loading).toBeFalse();

    const retryLoad = library.load();
    expect(library.getSnapshot().loadError).toBeUndefined();
    latestRead(reads).resolve([world("w1", "Midgard")]);
    await retryLoad;
    const recovered = library.getSnapshot();
    expect(itemIds(recovered)).toEqual(["w1"]);
    expect(recovered.loadError).toBeUndefined();
    expect(recovered.loading).toBeFalse();
  });

  test("keeps records through a failed revalidation and holds the notice until a read succeeds", async () => {
    const reads: Array<Deferred<World[]>> = [];
    const library = trackedLibrary<World>(reads, "Could not load worlds.");
    const midgard = world("w1", "Midgard");
    const seedLoad = library.load();
    latestRead(reads).resolve([midgard]);
    await seedLoad;

    const failedLoad = library.load();
    latestRead(reads).reject(new Error("still offline"));
    await failedLoad;
    const failed = library.getSnapshot();
    expect(itemIds(failed)).toEqual(["w1"]);
    expect(failed.refreshError).not.toBeUndefined();
    expect(failed.loading).toBeFalse();

    const retryLoad = library.load();
    const pending = library.getSnapshot();
    expect(pending.loading).toBeTrue();
    expect(pending.refreshError).not.toBeUndefined();
    latestRead(reads).resolve([midgard, world("w2", "Umbra")]);
    await retryLoad;
    const settled = library.getSnapshot();
    expect(settled.refreshError).toBeUndefined();
    expect(itemIds(settled)).toEqual(["w1", "w2"]);
  });

  test("applies only the latest read when reads overlap", async () => {
    const reads: Array<Deferred<World[]>> = [];
    const library = trackedLibrary<World>(reads, "Could not load worlds.");
    const firstLoad = library.load();
    const secondLoad = library.load();

    latestRead(reads).resolve([world("w2", "Umbra")]);
    await secondLoad;
    reads[reads.length - 2].resolve([world("w-old", "Ruins")]);
    await firstLoad;

    const snapshot = library.getSnapshot();
    expect(itemIds(snapshot)).toEqual(["w2"]);
    expect(snapshot.loading).toBeFalse();
  });

  test("a save during a held read survives the older response and reconciles the full list", async () => {
    const reads: Array<Deferred<World[]>> = [];
    const library = trackedLibrary<World>(reads, "Could not load worlds.");
    const midgard = world("w1", "Midgard");
    const seedLoad = library.load();
    latestRead(reads).resolve([midgard]);
    await seedLoad;

    const heldLoad = library.load();
    const heldRead = latestRead(reads);
    const created = world("w9", "Vashkel");
    library.applySaved(created, undefined);
    expect(itemIds(library.getSnapshot())).toEqual(["w9", "w1"]);

    heldRead.resolve([midgard]);
    await heldLoad;
    expect(itemIds(library.getSnapshot())).toContain("w9");

    const reconcileRead = latestRead(reads);
    reconcileRead.resolve([midgard, created, world("w3", "Umbra")]);
    await reconcileRead.promise;
    expect(itemIds(library.getSnapshot())).toEqual(["w1", "w9", "w3"]);
    expect(library.getSnapshot().loading).toBeFalse();
  });

  test("an edit during a held read lands in place and beats the pre-edit response", async () => {
    const reads: Array<Deferred<World[]>> = [];
    const library = trackedLibrary<World>(reads, "Could not load worlds.");
    const midgard = world("w1", "Midgard");
    const umbra = world("w2", "Umbra");
    const seedLoad = library.load();
    latestRead(reads).resolve([midgard, umbra]);
    await seedLoad;

    const heldLoad = library.load();
    const heldRead = latestRead(reads);
    const renamed = { ...midgard, name: "Midgard Reach" };
    library.applySaved(renamed, midgard.id);
    const edited = library.getSnapshot();
    expect(itemIds(edited)).toEqual(["w1", "w2"]);
    expect(edited.items?.[0]?.name).toBe("Midgard Reach");

    heldRead.resolve([midgard, umbra]);
    await heldLoad;
    expect(library.getSnapshot().items?.[0]?.name).toBe("Midgard Reach");

    const reconcileRead = latestRead(reads);
    reconcileRead.resolve([renamed, umbra]);
    await reconcileRead.promise;
    const settled = library.getSnapshot();
    expect(itemIds(settled)).toEqual(["w1", "w2"]);
    expect(settled.items?.[0]?.name).toBe("Midgard Reach");
    expect(settled.loading).toBeFalse();
  });

  test("a save during the cold read keeps a character and reconciles the full list", async () => {
    const reads: Array<Deferred<Character[]>> = [];
    const library = trackedLibrary<Character>(reads, "Could not load characters.");

    const coldLoad = library.load();
    const coldRead = latestRead(reads);
    const created = character("c9", "Ilse");
    library.applySaved(created, undefined);
    expect(itemIds(library.getSnapshot())).toEqual(["c9"]);

    coldRead.resolve([]);
    await coldLoad;
    expect(itemIds(library.getSnapshot())).toEqual(["c9"]);

    const reconcileRead = latestRead(reads);
    reconcileRead.resolve([character("c1", "Nils"), created]);
    await reconcileRead.promise;
    expect(itemIds(library.getSnapshot())).toEqual(["c1", "c9"]);
    expect(library.getSnapshot().loading).toBeFalse();
  });
});
