import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Chat, Message, World } from "../../shared/domain";
import { NARRATION_TOKEN_BUDGET } from "../../shared/narration";
import {
  configureProvider,
  headersWith,
  makeConfigDirectory,
  openAiChatCompletionSse,
  removeDirectory,
  startTestServer,
  type TestServer,
} from "./helpers";

const ORIGIN = "http://localhost:5173";

let configDirectory: string;
let databasePath: string;
let replies: string[] = [];
let held: { release: () => void } | null = null;
let server: TestServer;

/** Answers each upstream call with the next canned reply; `held` keeps the stream open until released. */
const upstream = (async () => {
  const text = replies.shift() ?? "Narration.";
  if (held === null) {
    return new Response(openAiChatCompletionSse("glm-5.3", [text]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  const encoder = new TextEncoder();
  const frames = openAiChatCompletionSse("glm-5.3", [text])
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => `${frame}\n\n`);
  const stop = frames.findIndex((frame) => frame.includes('"finish_reason":"stop"'));
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  held.release = release;
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames.slice(0, stop)) controller.enqueue(encoder.encode(frame));
        await gate;
        for (const frame of frames.slice(stop)) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}) as unknown as typeof fetch;

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  databasePath = join(configDirectory, "chats.db");
  server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
  await configureProvider(server.url, "sk-chats-test-key");
});

afterAll(async () => {
  await server?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

async function call(url: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${server.url}${url}`, {
    method,
    headers: headersWith({
      ...(method === "GET" ? {} : { origin: ORIGIN }),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function create<T>(url: string, body: unknown, key: string): Promise<T> {
  const response = await call(url, "POST", body);
  expect(response.status).toBe(201);
  return ((await response.json()) as Record<string, T>)[key]!;
}

interface Seeded {
  world: World;
  hero: { id: string };
  friend: { id: string };
}

async function seedWorld(name: string): Promise<Seeded> {
  const world = await create<World>("/api/worlds", { name, setting_brief: "A rain-soaked harbor kingdom." }, "world");
  const hero = await create<{ id: string }>(`/api/worlds/${world.id}/characters`, { name: `Sable ${name}`, description: "A cynical ferrywoman." }, "character");
  const friend = await create<{ id: string }>(`/api/worlds/${world.id}/characters`, { name: `Corin ${name}`, description: "A dockhand." }, "character");
  return { world, hero, friend };
}

async function play(chatId: string, content: string): Promise<void> {
  const response = await call(`/api/chats/${chatId}/messages`, "POST", { content });
  expect(response.status).toBe(200);
  await response.text();
}

async function transcript(chatId: string): Promise<Message[]> {
  const response = await call(`/api/chats/${chatId}/messages`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { messages: Message[] }).messages;
}

describe("chat creation", () => {
  test("creates a chat with the protagonist, opening, and a title from the opening's first line", async () => {
    const { world, hero } = await seedWorld("Creation");
    const chat = await create<Chat>(
      `/api/worlds/${world.id}/chats`,
      { protagonist_id: hero.id, opening: `  ${"x".repeat(80)}\nSecond line.` },
      "chat",
    );
    expect(chat).toMatchObject({ world_id: world.id, protagonist_id: hero.id, opening: `${"x".repeat(80)}\nSecond line.` });
    expect(chat.title).toBe("x".repeat(60));
    expect(await transcript(chat.id)).toEqual([]);

    const untitled = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id }, "chat");
    expect(untitled).toMatchObject({ title: "New chat", opening: "" });

    const named = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id, title: " Night shift " }, "chat");
    expect(named.title).toBe("Night shift");
  });

  test("the protagonist must be a character of that world", async () => {
    const { world } = await seedWorld("Own");
    const other = await seedWorld("Other");
    for (const protagonist_id of [other.hero.id, "missing"]) {
      const response = await call(`/api/worlds/${world.id}/chats`, "POST", { protagonist_id });
      expect(response.status).toBe(404);
    }
    expect((await call(`/api/worlds/${world.id}/chats`, "POST", {})).status).toBe(400);
    expect((await call("/api/worlds/missing/chats", "POST", { protagonist_id: other.hero.id })).status).toBe(404);
    expect((await call(`/api/worlds/${world.id}/chats`, "POST", { protagonist_id: other.hero.id, title: " " })).status).toBe(400);
    expect(((await (await call(`/api/worlds/${world.id}/chats`)).json()) as { chats: Chat[] }).chats).toEqual([]);
  });

  test("an opening prompt past the narration budget is refused and nothing is created", async () => {
    const { world, hero } = await seedWorld("Budget");
    const response = await call(`/api/worlds/${world.id}/chats`, "POST", {
      protagonist_id: hero.id,
      opening: " b".repeat(NARRATION_TOKEN_BUDGET + 1),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_input");
    expect(body.error).toContain(`the budget is ${NARRATION_TOKEN_BUDGET}`);
    expect(((await (await call(`/api/worlds/${world.id}/chats`)).json()) as { chats: Chat[] }).chats).toEqual([]);
  });
});

describe("chat reads and edits", () => {
  test("lists chats most recently updated first, across worlds and per world", async () => {
    const first = await seedWorld("Listing A");
    const second = await seedWorld("Listing B");
    const a = await create<Chat>(`/api/worlds/${first.world.id}/chats`, { protagonist_id: first.hero.id, title: "A" }, "chat");
    const b = await create<Chat>(`/api/worlds/${second.world.id}/chats`, { protagonist_id: second.hero.id, title: "B" }, "chat");
    const c = await create<Chat>(`/api/worlds/${first.world.id}/chats`, { protagonist_id: first.friend.id, title: "C" }, "chat");

    const ids = async (url: string) => ((await (await call(url)).json()) as { chats: Chat[] }).chats.map((chat) => chat.id);
    expect(await ids(`/api/worlds/${first.world.id}/chats`)).toEqual([c.id, a.id]);
    expect((await ids("/api/chats")).slice(0, 3)).toEqual([c.id, b.id, a.id]);

    await play(a.id, "I knock.");
    expect((await ids("/api/chats")).slice(0, 3)).toEqual([a.id, c.id, b.id]);
    expect(await ids(`/api/worlds/${first.world.id}/chats`)).toEqual([a.id, c.id]);
  });

  test("GET returns the chat with its world; PATCH renames; unknown ids are 404", async () => {
    const { world, hero } = await seedWorld("Rename");
    const chat = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id }, "chat");

    const read = (await (await call(`/api/chats/${chat.id}`)).json()) as { chat: Chat; world: World };
    expect(read.chat).toEqual(chat);
    expect(read.world).toEqual(world);

    const renamed = await call(`/api/chats/${chat.id}`, "PATCH", { title: "Harbor run" });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { chat: Chat }).chat.title).toBe("Harbor run");
    expect((await call(`/api/chats/${chat.id}`, "PATCH", { title: "" })).status).toBe(400);

    expect((await call("/api/chats/missing")).status).toBe(404);
    expect((await call("/api/chats/missing", "PATCH", { title: "x" })).status).toBe(404);
    expect((await call("/api/chats/missing", "DELETE")).status).toBe(404);
  });

  test("playing never writes to the world", async () => {
    const { world, hero } = await seedWorld("Readonly");
    const chat = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id, opening: "Dusk." }, "chat");
    const before = await (await call(`/api/worlds/${world.id}/characters`)).text();
    await play(chat.id, "I wave.");
    expect(await (await call(`/api/worlds/${world.id}/characters`)).text()).toBe(before);
    expect(((await (await call(`/api/worlds/${world.id}`)).json()) as { world: World }).world).toEqual(world);
  });
});

describe("branch", () => {
  test("copies the selected path up to and including the chosen message into a new chat", async () => {
    const { world, hero } = await seedWorld("Branch");
    const chat = await create<Chat>(
      `/api/worlds/${world.id}/chats`,
      { protagonist_id: hero.id, opening: "Fog rolls in.", title: "Source" },
      "chat",
    );
    replies.push("First narration.", "Second narration.", "Third narration.");
    await play(chat.id, "I light the lamp.");
    await play(chat.id, "I climb the stairs.");
    const regenerated = await call(`/api/chats/${chat.id}/regenerate`, "POST", {});
    expect(regenerated.status).toBe(200);
    await regenerated.text();

    const source = await transcript(chat.id);
    expect(source.map((message) => message.content)).toEqual([
      "I light the lamp.",
      "First narration.",
      "I climb the stairs.",
      "Third narration.",
    ]);
    const cut = source[2]!;

    const response = await call(`/api/chats/${chat.id}/messages/${cut.id}/branch`, "POST", {});
    expect(response.status).toBe(201);
    const branch = ((await response.json()) as { chat: Chat }).chat;
    expect(branch).toMatchObject({
      world_id: world.id,
      protagonist_id: hero.id,
      opening: "Fog rolls in.",
      title: "Source (branch)",
    });
    expect(branch.id).not.toBe(chat.id);

    const copied = await transcript(branch.id);
    expect(copied.map((message) => [message.position, message.role, message.speaker_name, message.content])).toEqual([
      [1, "user", source[0]!.speaker_name, "I light the lamp."],
      [2, "assistant", "Narrator", "First narration."],
      [3, "user", source[2]!.speaker_name, "I climb the stairs."],
    ]);
    expect(copied.every((message) => message.id !== source.find((original) => original.content === message.content)?.id)).toBe(true);
    expect((await transcript(chat.id)).map((message) => message.content)).toEqual(source.map((message) => message.content));

    replies.push("Branch narration.");
    await play(branch.id, "I turn back.");
    expect((await transcript(branch.id)).at(-1)!.content).toBe("Branch narration.");
    expect((await transcript(chat.id)).at(-1)!.content).toBe("Third narration.");

    const named = await call(`/api/chats/${chat.id}/messages/${source[0]!.id}/branch`, "POST", { title: "What if" });
    expect(((await named.json()) as { chat: Chat }).chat.title).toBe("What if");
  });

  test("unknown messages are 404, another chat's message is 404, and a pending source is busy", async () => {
    const { world, hero } = await seedWorld("BranchGuards");
    const chat = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id }, "chat");
    const other = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id }, "chat");
    await play(other.id, "Elsewhere.");
    const foreign = (await transcript(other.id))[0]!;

    expect((await call(`/api/chats/${chat.id}/messages/missing/branch`, "POST", {})).status).toBe(404);
    expect((await call(`/api/chats/${chat.id}/messages/${foreign.id}/branch`, "POST", {})).status).toBe(404);
    expect((await call("/api/chats/missing/messages/x/branch", "POST", {})).status).toBe(404);

    await play(chat.id, "Done.");
    const complete = (await transcript(chat.id))[0]!;
    held = { release: () => {} };
    try {
      const pending = await call(`/api/chats/${chat.id}/messages`, "POST", { content: "Pending." });
      expect(pending.status).toBe(200);
      const busy = await call(`/api/chats/${chat.id}/messages/${complete.id}/branch`, "POST", {});
      expect(busy.status).toBe(409);
      expect(((await busy.json()) as { code: string }).code).toBe("busy");
      await call(`/api/chats/${chat.id}/stop`, "POST");
      await pending.text();
    } finally {
      held = null;
    }
    expect((await call(`/api/chats/${chat.id}/messages/${complete.id}/branch`, "POST", {})).status).toBe(201);
  });
});

describe("discard", () => {
  test("deletes the chat and its whole transcript, alternates included", async () => {
    const { world, hero } = await seedWorld("Discard");
    const chat = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id }, "chat");
    await play(chat.id, "I speak.");
    await (await call(`/api/chats/${chat.id}/regenerate`, "POST", {})).text();

    const response = await call(`/api/chats/${chat.id}`, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await call(`/api/chats/${chat.id}`)).status).toBe(404);
    expect((await call(`/api/chats/${chat.id}/messages`)).status).toBe(404);
    expect(((await (await call(`/api/worlds/${world.id}/chats`)).json()) as { chats: Chat[] }).chats).toEqual([]);
    expect((await call(`/api/worlds/${world.id}`)).status).toBe(200);
  });

  test("is refused 409 busy while a reply is pending, and works once it is stopped", async () => {
    const { world, hero } = await seedWorld("DiscardBusy");
    const chat = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id }, "chat");
    held = { release: () => {} };
    try {
      const pending = await call(`/api/chats/${chat.id}/messages`, "POST", { content: "Wait for it." });
      expect(pending.status).toBe(200);

      const refused = await call(`/api/chats/${chat.id}`, "DELETE");
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe("busy");
      expect((await call(`/api/chats/${chat.id}`)).status).toBe(200);

      await call(`/api/chats/${chat.id}/stop`, "POST");
      await pending.text();
    } finally {
      held = null;
    }
    expect((await call(`/api/chats/${chat.id}`, "DELETE")).status).toBe(200);
  });

  test("a character is protected while it is any chat's protagonist", async () => {
    const { world, hero, friend } = await seedWorld("Protected");
    const chat = await create<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: hero.id }, "chat");

    const refused = await call(`/api/characters/${hero.id}`, "DELETE");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("conflict");
    expect((await call(`/api/characters/${hero.id}`)).status).toBe(200);

    expect((await call(`/api/characters/${friend.id}`, "DELETE")).status).toBe(200);
    expect((await call(`/api/chats/${chat.id}`, "DELETE")).status).toBe(200);
    expect((await call(`/api/characters/${hero.id}`, "DELETE")).status).toBe(200);
  });
});
