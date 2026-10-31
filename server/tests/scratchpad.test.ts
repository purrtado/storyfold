import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Chat, Message, ScratchMessage } from "../../shared/domain";
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
const MODEL = "glm-5.3";

interface Call {
  system: string;
  turns: Array<{ role: string; content: string }>;
  scratchpad: boolean;
  release: () => void;
}

/** How the stub answers each upstream call; held calls stream nothing until released. */
let answer: (call: Omit<Call, "release">) => { text: string; hold?: boolean };
let calls: Call[];

const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
  const system = body.messages[0]?.role === "system" ? body.messages[0].content : "";
  const seen = { system, turns: body.messages.filter((message) => message.role !== "system"), scratchpad: system.includes("<scratchpad_role>") };
  const { text, hold } = answer(seen);
  const gate = Promise.withResolvers<void>();
  calls.push({ ...seen, release: () => gate.resolve() });
  if (!hold) gate.resolve();
  const frames = openAiChatCompletionSse(MODEL, [text]).split("\n\n").filter((frame) => frame.length > 0).map((frame) => `${frame}\n\n`);
  // The content delta goes out at once so headers flush; the terminal frames wait for release.
  const finish = frames.findIndex((frame) => frame.includes('"finish_reason":"stop"'));
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames.slice(0, finish)) controller.enqueue(encoder.encode(frame));
      void gate.promise.then(() => {
        try {
          for (const frame of frames.slice(finish)) controller.enqueue(encoder.encode(frame));
          controller.close();
        } catch {
          // The consumer went away (Stop or disconnect).
        }
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

let directory: string;
let databasePath: string;
let server: TestServer;

beforeAll(async () => {
  directory = await makeConfigDirectory();
  databasePath = join(directory, "scratchpad.db");
  server = await startTestServer({ configDirectory: directory, databasePath, upstreamFetch: upstream });
  await configureProvider(server.url, "sk-scratchpad-test");
});

afterAll(async () => {
  await server?.stop();
  if (directory) await removeDirectory(directory);
});

beforeEach(() => {
  calls = [];
  answer = ({ scratchpad }) => ({ text: scratchpad ? "Scratch reply." : "The bells fall silent." });
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method,
    headers: headersWith({ origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function created<T>(path: string, body: unknown, key: string): Promise<T> {
  const response = await call("POST", path, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as Record<string, T>)[key]!;
}

/** A world with a protagonist, an offstage character, and a keyword-only lore entry. */
async function seedChat(): Promise<Chat> {
  const world = await created<{ id: string }>("/api/worlds", { name: "Veloria", setting_brief: "A rain-soaked harbor kingdom." }, "world");
  const sable = await created<{ id: string }>(`/api/worlds/${world.id}/characters`, { name: "Sable", description: "A ferrywoman spy." }, "character");
  await created(`/api/worlds/${world.id}/characters`, { name: "Corin", description: "The harbormaster, secretly in debt.", context_mode: "mentioned" }, "character");
  await created(`/api/worlds/${world.id}/entries`, { kind: "lore", name: "Bell Tower", description: "Its bells ring only for drowned sailors.", keywords: ["bells"] }, "entry");
  return created<Chat>(`/api/worlds/${world.id}/chats`, { protagonist_id: sable.id, opening: "Sable docks at dawn." }, "chat");
}

const scratchpad = (chatId: string) => `/api/chats/${chatId}/scratchpad`;

async function thread(chatId: string): Promise<ScratchMessage[]> {
  const response = await call("GET", scratchpad(chatId));
  expect(response.status).toBe(200);
  return ((await response.json()) as { messages: ScratchMessage[] }).messages;
}

async function transcript(chatId: string): Promise<Message[]> {
  return ((await (await call("GET", `/api/chats/${chatId}/messages`)).json()) as { messages: Message[] }).messages;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("scratchpad", () => {
  test("reads the whole world and transcript, and its thread never reaches the narrator", async () => {
    const chat = await seedChat();
    await (await call("POST", `/api/chats/${chat.id}/messages`, { content: "I listen at the pier." })).text();

    const asked = await call("POST", scratchpad(chat.id), { content: "Is Corin hiding something?" });
    expect(asked.status).toBe(200);
    await asked.text();
    const scratchCall = calls.at(-1)!;
    expect(scratchCall.scratchpad).toBe(true);
    // Characters and lore the narrator only gets on mention are all there, with the story so far.
    for (const text of ["The harbormaster, secretly in debt.", "Its bells ring only for drowned sailors.", "Sable docks at dawn.", "I listen at the pier.", "The bells fall silent."]) {
      expect(scratchCall.system).toContain(text);
    }
    expect(scratchCall.turns).toEqual([{ role: "user", content: "Is Corin hiding something?" }]);
    expect((await thread(chat.id)).map((message) => [message.role, message.content, message.status])).toEqual([
      ["user", "Is Corin hiding something?", "complete"],
      ["assistant", "Scratch reply.", "complete"],
    ]);

    await (await call("POST", `/api/chats/${chat.id}/messages`, { content: "I walk on." })).text();
    const narratorCall = calls.at(-1)!;
    expect(narratorCall.scratchpad).toBe(false);
    expect(JSON.stringify(narratorCall)).not.toContain("Is Corin hiding something?");
    expect(JSON.stringify(narratorCall)).not.toContain("Scratch reply.");
  });

  test("runs beside the narrator; each is busy only with its own reply, and Stop is separate", async () => {
    const chat = await seedChat();
    answer = () => ({ text: "Held.", hold: true });

    const narration = await call("POST", `/api/chats/${chat.id}/messages`, { content: "I wait." });
    expect(narration.status).toBe(200);
    const scratch = await call("POST", scratchpad(chat.id), { content: "What now?" });
    expect(scratch.status).toBe(200);

    const secondScratch = await call("POST", scratchpad(chat.id), { content: "And then?" });
    expect(secondScratch.status).toBe(409);
    expect(await errorCode(secondScratch)).toBe("busy");
    const clear = await call("DELETE", scratchpad(chat.id));
    expect(clear.status).toBe(409);
    const discard = await call("DELETE", `/api/chats/${chat.id}`);
    expect(discard.status).toBe(409);

    const stopped = await call("POST", `${scratchpad(chat.id)}/stop`);
    expect(((await stopped.json()) as { pending: boolean }).pending).toBe(true);
    expect((await thread(chat.id)).at(-1)!.status).toBe("interrupted");
    expect((await transcript(chat.id)).at(-1)!.status).toBe("pending");

    for (const held of calls) held.release();
    await narration.text();
    await scratch.text().catch(() => "");
    expect((await transcript(chat.id)).at(-1)!.status).toBe("complete");
    expect((await call("DELETE", `/api/chats/${chat.id}`)).status).toBe(200);
  });

  test("regenerate replaces the trailing reply; messages delete one at a time and clear empties the thread", async () => {
    const chat = await seedChat();
    const other = await seedChat();

    const empty = await call("POST", `${scratchpad(chat.id)}/regenerate`, {});
    expect(empty.status).toBe(409);
    expect(await errorCode(empty)).toBe("nothing_to_regenerate");

    await (await call("POST", scratchpad(chat.id), { content: "Recap?" })).text();
    answer = () => ({ text: "A better recap." });
    await (await call("POST", `${scratchpad(chat.id)}/regenerate`, {})).text();
    const rows = await thread(chat.id);
    expect(rows.map((message) => message.content)).toEqual(["Recap?", "A better recap."]);
    // The retry is sent the same thread, not the reply it replaced.
    expect(calls.at(-1)!.turns).toEqual([{ role: "user", content: "Recap?" }]);

    expect((await call("DELETE", `${scratchpad(other.id)}/messages/${rows[0]!.id}`)).status).toBe(404);
    const afterDelete = await call("DELETE", `${scratchpad(chat.id)}/messages/${rows[1]!.id}`);
    expect(((await afterDelete.json()) as { messages: ScratchMessage[] }).messages.map((message) => message.id)).toEqual([rows[0]!.id]);

    expect((await call("DELETE", scratchpad(chat.id))).status).toBe(200);
    expect(await thread(chat.id)).toEqual([]);
  });

  test("a request past the budget is refused and saves nothing", async () => {
    const chat = await seedChat();
    const long = "lantern ".repeat(12_000).trim();
    for (let turn = 0; turn < 5; turn += 1) {
      const response = await call("POST", scratchpad(chat.id), { content: long });
      if (response.status === 413) {
        expect(await errorCode(response)).toBe("context_limit");
        expect(await thread(chat.id)).toHaveLength(turn * 2);
        return;
      }
      expect(response.status).toBe(200);
      await response.text();
    }
    throw new Error("the budget was never reached");
  });

  test("discarding a chat deletes its thread", async () => {
    const chat = await seedChat();
    await (await call("POST", scratchpad(chat.id), { content: "Hello?" })).text();
    expect((await call("DELETE", `/api/chats/${chat.id}`)).status).toBe(200);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM scratch_messages WHERE chat_id = ?").get(chat.id)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
