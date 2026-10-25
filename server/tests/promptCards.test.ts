import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PromptCard } from "../../shared/domain";
import { DEFAULT_PROMPT_CARDS } from "../../shared/narration";
import { openDatabase } from "../db";
import { createCampaign, createCharacter, createWorld, parseCharacterInput } from "../library";
import { PlayService } from "../play";
import { createPromptCard, listPromptCards, reorderPromptCards, updatePromptCard } from "../promptCards";
import { headersWith, startTestServer, type TestServer } from "./helpers";

const TRUSTED_ORIGIN = "http://localhost:5173";

describe("narrator prompt from cards", () => {
  test("enabled cards are sent in order; a card whose placeholder is empty is left out", () => {
    const db = openDatabase(":memory:");
    try {
      const world = createWorld(db, { name: "Veloria", setting_brief: "A drowned city.", suggested_starting_situation: "" });
      const hero = createCharacter(db, parseCharacterInput({ name: "Sable", description: "A smuggler." }));
      const { session } = createCampaign(db, { world_id: world.id, protagonist_id: hero.id, starting_situation: "At the docks." });
      const play = new PlayService(db);

      const defaults = play.systemPrompt(session.id);
      expect(defaults.startsWith("You are the narrator of an ongoing interactive story.\n\nWorld — Veloria: A drowned city.")).toBe(true);
      // No cast, notes, or relationships: their headings are not sent.
      expect(defaults).not.toContain("Narrator-controlled cast:");
      expect(defaults).not.toContain("Current campaign state:");
      expect(defaults).toContain("never tag Sable.");

      const cards = listPromptCards(db);
      const role = cards.find((card) => card.title === "Narrator role")!;
      updatePromptCard(db, role.id, { enabled: false });
      const style = createPromptCard(db, { title: "Style", body: "Write tersely for {{protagonist_name}}.", enabled: true });
      reorderPromptCards(db, [style.id, ...cards.map((card) => card.id)]);

      const edited = play.systemPrompt(session.id);
      expect(edited.startsWith("Write tersely for Sable.\n\nWorld — Veloria")).toBe(true);
      expect(edited).not.toContain("You are the narrator");
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
    const response = await call("PATCH", `/${first!.id}`, { body: "Hello {{cats}} and {{ cast }} and {{cast}}." });
    expect(response.status).toBe(400);
    const error = (await response.json()) as { error: string; code: string };
    expect(error.code).toBe("invalid_input");
    expect(error.error).toContain("{{cats}}");
    expect(error.error).toContain("{{ cast }}");
    expect((await cards())[0]!.body).toBe(first!.body);
  });

  test("order must name every card exactly once and needs a trusted origin", async () => {
    const ids = (await cards()).map((card) => card.id);
    expect((await call("PUT", "/order", { ids: ids.slice(1) })).status).toBe(400);
    expect((await call("PUT", "/order", { ids: [ids[0], ...ids.slice(0, -1)] })).status).toBe(400);
    expect((await call("PUT", "/order", { ids: ids.toReversed() }, null)).status).toBe(403);

    const reordered = await call("PUT", "/order", { ids: ids.toReversed() });
    expect(reordered.status).toBe(200);
    expect((await cards()).map((card) => card.id)).toEqual(ids.toReversed());
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
