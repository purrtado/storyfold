import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PromptCard, PromptPreset } from "../../shared/domain";
import { DEFAULT_PROMPT_CARDS, PROMPT_PLACEHOLDERS } from "../../shared/narration";
import { createChat } from "../chats";
import { openDatabase } from "../db";
import { chatSystemPrompt } from "../grounding";
import { activatePromptPreset, createPromptCard, createPromptPreset, listPromptCards, reorderPromptCards, updatePromptCard } from "../promptCards";
import { createCharacter, createWorld, parseCharacterInput } from "../worlds";
import { headersWith, startTestServer, type TestServer } from "./helpers";

const TRUSTED_ORIGIN = "http://localhost:5173";

describe("narrator prompt from cards", () => {
  test("enabled cards are sent in order; a card whose placeholder is empty is left out", () => {
    const db = openDatabase(":memory:");
    try {
      const world = createWorld(db, { name: "Veloria", setting_brief: "A drowned city." });
      const hero = createCharacter(db, world.id, parseCharacterInput({ name: "Sable", description: "A smuggler." }))!;
      const chat = createChat(db, world.id, { protagonist_id: hero.id, opening: "At the docks." })!;

      const defaults = chatSystemPrompt(db, chat);
      expect(defaults.startsWith("<narrator_role>\nYou are the narrator of an ongoing interactive story.\n</narrator_role>\n\n")).toBe(true);
      expect(defaults).toContain("<world>\nVeloria: A drowned city.\n</world>");
      expect(defaults).not.toContain("At the docks.");
      // No cast or relationships: their sections are not sent.
      expect(defaults).not.toContain("<cast>");
      expect(defaults).not.toContain("<relationships>");
      expect(defaults).toContain("never tag Sable.");

      const cards = listPromptCards(db);
      const role = cards.find((card) => card.title === "Narrator role")!;
      updatePromptCard(db, role.id, { enabled: false });
      const style = createPromptCard(db, { title: "Style & Tone", body: "Write tersely for {{protagonist_name}}.", enabled: true });
      reorderPromptCards(db, [style.id, ...cards.map((card) => card.id)]);

      const edited = chatSystemPrompt(db, chat);
      expect(edited.startsWith("<style_tone>\nWrite tersely for Sable.\n</style_tone>\n\n<world>")).toBe(true);
      expect(edited).not.toContain("You are the narrator");
    } finally {
      db.close();
    }
  });

  test("the narrator is sent the active preset's cards", () => {
    const db = openDatabase(":memory:");
    try {
      const world = createWorld(db, { name: "Veloria", setting_brief: "A drowned city." });
      const hero = createCharacter(db, world.id, parseCharacterInput({ name: "Sable", description: "A smuggler." }))!;
      const chat = createChat(db, world.id, { protagonist_id: hero.id, opening: "At the docks." })!;
      const original = db.query<{ id: string }, []>("SELECT id FROM prompt_presets WHERE active = 1").get()!.id;

      createPromptPreset(db, { name: "Terse", clone_of: null });
      const role = listPromptCards(db).find((card) => card.title === "Narrator role")!;
      updatePromptCard(db, role.id, { body: "Be terse." });
      expect(chatSystemPrompt(db, chat).startsWith("<narrator_role>\nBe terse.\n</narrator_role>")).toBe(true);

      activatePromptPreset(db, original);
      expect(chatSystemPrompt(db, chat).startsWith("<narrator_role>\nYou are the narrator of an ongoing interactive story.\n</narrator_role>")).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("prompt card API", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  function call(method: string, path: string, body?: unknown, origin: string | null = TRUSTED_ORIGIN): Promise<Response> {
    return fetch(`${server.url}/api/prompt-cards${path}`, {
      method,
      headers: headersWith({
        ...(origin !== null ? { origin } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function cards(): Promise<PromptCard[]> {
    return ((await (await call("GET", "")).json()) as { cards: PromptCard[] }).cards;
  }

  test("unknown placeholders are refused by name and nothing is saved", async () => {
    const [first] = await cards();
    const response = await call("PATCH", `/${first!.id}`, { body: "Hello {{cats}} and {{ cast }} and {{cast\n}} and {{cast}}." });
    expect(response.status).toBe(400);
    const error = (await response.json()) as { error: string; code: string };
    expect(error.code).toBe("invalid_input");
    expect(error.error).toContain("{{cats}}");
    expect(error.error).toContain("{{ cast }}");
    expect(error.error).toContain("{{cast\n}}");
    expect((await cards())[0]!.body).toBe(first!.body);
  });

  test("every current placeholder is accepted; the retired situation and notes placeholders are refused", async () => {
    const [first] = await cards();
    for (const name of PROMPT_PLACEHOLDERS) {
      expect((await call("PATCH", `/${first!.id}`, { body: `{{${name}}}` })).status).toBe(200);
    }
    for (const name of ["situation", "notes"]) {
      const refused = await call("PATCH", `/${first!.id}`, { body: `{{${name}}}` });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain(`{{${name}}}`);
    }
    expect((await cards())[0]!.body).toBe(`{{${PROMPT_PLACEHOLDERS.at(-1)}}}`);
  });

  test("order must name every card exactly once and needs a trusted origin", async () => {
    const ids = (await cards()).map((card) => card.id);
    const reversed = [...ids].reverse();
    expect((await call("PUT", "/order", { ids: ids.slice(1) })).status).toBe(400);
    expect((await call("PUT", "/order", { ids: [ids[0], ...ids.slice(0, -1)] })).status).toBe(400);
    expect((await call("PUT", "/order", { ids: reversed }, null)).status).toBe(403);

    const reordered = await call("PUT", "/order", { ids: reversed });
    expect(reordered.status).toBe(200);
    expect((await cards()).map((card) => card.id)).toEqual(reversed);
  });

  test("reset restores the default cards, enabled and in order", async () => {
    const created = await call("POST", "", { title: "Extra" });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { card: PromptCard }).card).toMatchObject({ title: "Extra", body: "", enabled: true });

    const reset = await call("POST", "/reset");
    expect(reset.status).toBe(200);
    const restored = await cards();
    expect(restored.map(({ title, body, enabled }) => ({ title, body, enabled }))).toEqual(
      DEFAULT_PROMPT_CARDS.map((card) => ({ ...card, enabled: true })),
    );
  });
});

describe("prompt preset API", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${server.url}/api${path}`, {
      method,
      headers: headersWith({
        origin: TRUSTED_ORIGIN,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function presets(): Promise<PromptPreset[]> {
    return ((await (await call("GET", "/prompt-presets")).json()) as { presets: PromptPreset[] }).presets;
  }

  async function cards(): Promise<PromptCard[]> {
    return ((await (await call("GET", "/prompt-cards")).json()) as { cards: PromptCard[] }).cards;
  }

  const shape = (list: PromptCard[]) => list.map(({ title, body, enabled }) => ({ title, body, enabled }));

  test("a fresh workspace has one active Default preset", async () => {
    expect((await presets()).map(({ name, active }) => ({ name, active }))).toEqual([{ name: "Default", active: true }]);
  });

  test("a copy keeps cards, order and switches; edits and resets stay in their own preset", async () => {
    const [source] = await presets();
    const original = await cards();
    await call("PATCH", `/prompt-cards/${original[0]!.id}`, { enabled: false });
    await call("PUT", "/prompt-cards/order", { ids: original.map((card) => card.id).reverse() });
    const sourceCards = await cards();

    const created = await call("POST", "/prompt-presets", { name: "Experiment", clone_of: source!.id });
    expect(created.status).toBe(201);
    const copy = ((await created.json()) as { preset: PromptPreset }).preset;
    expect(copy).toMatchObject({ name: "Experiment", active: true });
    expect((await presets()).filter((preset) => preset.active).map((preset) => preset.id)).toEqual([copy.id]);

    const copied = await cards();
    expect(shape(copied)).toEqual(shape(sourceCards));
    expect(copied.some((card) => sourceCards.some((other) => other.id === card.id))).toBe(false);

    await call("PATCH", `/prompt-cards/${copied[0]!.id}`, { body: "Only in the copy." });
    await call("POST", "/prompt-cards", { title: "Extra" });
    expect((await call("POST", "/prompt-cards/reset")).status).toBe(200);

    expect((await call("POST", `/prompt-presets/${source!.id}/activate`)).status).toBe(200);
    expect(shape(await cards())).toEqual(shape(sourceCards));
  });

  test("a new preset from the defaults ignores the active preset's edits", async () => {
    const response = await call("POST", "/prompt-presets", { name: "Fresh" });
    expect(response.status).toBe(201);
    expect(shape(await cards())).toEqual(DEFAULT_PROMPT_CARDS.map((card) => ({ ...card, enabled: true })));
  });

  test("rename needs a name; unknown presets answer 404 and create nothing", async () => {
    const [first] = await presets();
    expect((await call("PATCH", `/prompt-presets/${first!.id}`, { name: "  " })).status).toBe(400);
    const renamed = await call("PATCH", `/prompt-presets/${first!.id}`, { name: "Renamed" });
    expect(((await renamed.json()) as { preset: PromptPreset }).preset.name).toBe("Renamed");

    const before = await presets();
    expect((await call("POST", "/prompt-presets", { name: "Ghost", clone_of: "missing" })).status).toBe(404);
    expect((await call("POST", "/prompt-presets/missing/activate")).status).toBe(404);
    expect((await call("PATCH", "/prompt-presets/missing", { name: "Ghost" })).status).toBe(404);
    expect(await presets()).toEqual(before);
  });
});
