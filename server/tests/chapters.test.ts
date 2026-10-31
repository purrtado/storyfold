import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Chapter, Chat, Message } from "../../shared/domain";
import { CHAPTER_SUMMARY_PROMPT, openingMessage } from "../../shared/narration";
import {
  configureProvider,
  headersWith,
  makeConfigDirectory,
  openAiChatCompletionSse,
  removeDirectory,
  startTestServer,
  type TestServer,
} from "./helpers";

const TRUSTED_ORIGIN = "http://localhost:5173";
const OPENING_TEXT = "Sable docks at dawn while the harbor bells ring.";

type Reply = string | { status: number };
type Turn = { role: string; content: string };

/** Every upstream call in order; request i gets `replies[i]`, held until `gate` resolves when one is set. */
let replies: Reply[] = [];
let calls: Array<{ messages: Turn[] }> = [];
let gate: Promise<void> | null = null;
let arrived = Promise.withResolvers<void>();

const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
  calls.push(JSON.parse(String(init?.body)) as { messages: Turn[] });
  arrived.resolve();
  const reply = replies.shift() ?? "Onward.";
  if (gate) await gate;
  if (typeof reply !== "string") return new Response('{"error":{"message":"boom"}}', { status: reply.status });
  return new Response(openAiChatCompletionSse("glm-5.3", [reply]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}) as typeof fetch;

let configDirectory: string;
let server: TestServer;

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  server = await startTestServer({ configDirectory, databasePath: join(configDirectory, "chapters.db"), upstreamFetch: upstream });
  await configureProvider(server.url, "sk-chapters-test-key");
});

afterAll(async () => {
  await server?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method,
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedChat(): Promise<Chat> {
  replies = [];
  calls = [];
  const world = (await (await api("POST", "/api/worlds", { name: "Veloria", setting_brief: "A rain-soaked harbor kingdom." })).json()) as {
    world: { id: string };
  };
  const hero = (await (
    await api("POST", `/api/worlds/${world.world.id}/characters`, { name: "Sable", description: "A ferrywoman spy." })
  ).json()) as { character: { id: string } };
  const created = await api("POST", `/api/worlds/${world.world.id}/chats`, { protagonist_id: hero.character.id, opening: OPENING_TEXT });
  expect(created.status).toBe(201);
  return ((await created.json()) as { chat: Chat }).chat;
}

/** Plays the opening, then one turn per entry of `turns`; narration i is `narration[i]`. */
async function play(chat: Chat, narration: string[], turns: string[]): Promise<void> {
  replies.push(...narration);
  await (await api("POST", `/api/chats/${chat.id}/opening`, {})).text();
  for (const content of turns) await turn(chat, content);
}

async function turn(chat: Chat, content: string): Promise<Response> {
  const response = await api("POST", `/api/chats/${chat.id}/messages`, { content });
  await response.clone().text();
  return response;
}

async function transcript(chat: Chat): Promise<Message[]> {
  return ((await (await api("GET", `/api/chats/${chat.id}/messages`)).json()) as { messages: Message[] }).messages;
}

async function chapters(chat: Chat): Promise<Chapter[]> {
  return ((await (await api("GET", `/api/chats/${chat.id}/chapters`)).json()) as { chapters: Chapter[] }).chapters;
}

async function messageAt(chat: Chat, position: number): Promise<Message> {
  return (await transcript(chat)).find((message) => message.position === position)!;
}

async function summarize(chat: Chat, position: number, summary: string): Promise<Chapter> {
  replies.push(summary);
  const response = await api("POST", `/api/chats/${chat.id}/chapters`, { through_message_id: (await messageAt(chat, position)).id });
  expect(response.status).toBe(201);
  return ((await response.json()) as { chapter: Chapter }).chapter;
}

/** What the last upstream call sent besides the system prompt. */
function lastHistory(): Turn[] {
  return calls.at(-1)!.messages.filter((message) => message.role !== "system");
}

describe("chapters in model history", () => {
  test("a chapter stands in for its messages in narrator history while the transcript keeps them", async () => {
    const chat = await seedChat();
    await play(chat, ["The harbor wakes.", "The ferry sails.", "Vex waits at the bow."], ["I board the ferry.", "I look for Vex."]);

    const first = await summarize(chat, 3, "Sable boarded the ferry as it sailed.");
    expect(first).toMatchObject({ start_position: 1, end_position: 3, summary: "Sable boarded the ferry as it sailed.", edited: false, model: "glm-5.3" });
    const summaryCall = calls.at(-1)!.messages;
    expect(summaryCall[0]).toEqual({ role: "system", content: CHAPTER_SUMMARY_PROMPT });
    expect(summaryCall[1]!.content).toContain("I board the ferry.");
    expect(summaryCall[1]!.content).toContain("The ferry sails.");
    expect(summaryCall[1]!.content).not.toContain("Vex waits at the bow.");

    replies.push("Vex nods.");
    await turn(chat, "I greet Vex.");
    expect(lastHistory()).toEqual([
      { role: "user", content: `${openingMessage(OPENING_TEXT, [first.summary])}\n\nI look for Vex.` },
      { role: "assistant", content: "Vex waits at the bow." },
      { role: "user", content: "I greet Vex." },
    ]);
    expect(await transcript(chat)).toHaveLength(7);

    const second = await summarize(chat, 5, "Sable found Vex at the bow.");
    expect(second).toMatchObject({ start_position: 4, end_position: 5 });
    expect(calls.at(-1)!.messages[1]!.content).toContain(first.summary);

    replies.push("The bells fade.");
    await turn(chat, "I listen.");
    expect(lastHistory()[0]).toEqual({
      role: "user",
      content: `${openingMessage(OPENING_TEXT, [first.summary, second.summary])}\n\nI greet Vex.`,
    });
  });

  test("a turn refused for the narration budget fits once older messages are summarized", async () => {
    const chat = await seedChat();
    await play(chat, ["harbor ".repeat(38_000)], []);

    const refused = await turn(chat, "7 ".repeat(3_000));
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toContain("Summarize older messages into a chapter");

    await summarize(chat, 1, "The harbor woke.");
    const accepted = await turn(chat, "7 ".repeat(3_000));
    expect(accepted.status).toBe(200);
  });
});

describe("chapter ranges", () => {
  test("a chapter ends on a completed, selected narration after the last chapter", async () => {
    const chat = await seedChat();
    const other = await seedChat();
    await play(other, ["Elsewhere."], []);
    await play(chat, ["The harbor wakes.", "The ferry sails."], ["I board the ferry."]);
    const through = async (id: unknown) => api("POST", `/api/chats/${chat.id}/chapters`, { through_message_id: id });

    expect((await through((await messageAt(chat, 2)).id)).status).toBe(400);
    expect((await through(undefined)).status).toBe(400);
    expect((await through("missing")).status).toBe(404);
    expect((await through((await messageAt(other, 1)).id)).status).toBe(404);

    await summarize(chat, 3, "Sable boarded.");
    const covered = await through((await messageAt(chat, 1)).id);
    expect(covered.status).toBe(400);
    expect(await chapters(chat)).toHaveLength(1);
  });

  test("changing a summarized message drops its chapter and every later one", async () => {
    const chat = await seedChat();
    await play(chat, ["The harbor wakes.", "The ferry sails.", "Vex waits."], ["I board the ferry.", "I look for Vex."]);
    await summarize(chat, 1, "The harbor woke.");
    await summarize(chat, 3, "Sable boarded.");

    expect((await api("PATCH", `/api/chats/${chat.id}/messages/${(await messageAt(chat, 4)).id}`, { content: "I search." })).status).toBe(200);
    expect((await chapters(chat)).map((chapter) => chapter.end_position)).toEqual([1, 3]);

    expect((await api("PATCH", `/api/chats/${chat.id}/messages/${(await messageAt(chat, 2)).id}`, { content: "I swim." })).status).toBe(200);
    expect((await chapters(chat)).map((chapter) => chapter.end_position)).toEqual([1]);

    await summarize(chat, 5, "Sable swam and searched.");
    replies.push("Vex is gone.");
    await (await api("POST", `/api/chats/${chat.id}/regenerate`, {})).text();
    expect((await chapters(chat)).map((chapter) => chapter.end_position)).toEqual([1]);

    expect((await api("DELETE", `/api/chats/${chat.id}/messages/${(await messageAt(chat, 1)).id}`)).status).toBe(200);
    expect(await chapters(chat)).toEqual([]);
  });

  test("branching carries the chapters that end by the branch point, renumbered with their messages", async () => {
    const chat = await seedChat();
    await play(chat, ["The harbor wakes.", "The ferry sails.", "Vex waits.", "The bells ring."], ["I board.", "I look for Vex.", "I listen."]);
    expect((await api("DELETE", `/api/chats/${chat.id}/messages/${(await messageAt(chat, 2)).id}`)).status).toBe(200);
    const first = await summarize(chat, 5, "Sable looked for Vex.");
    await summarize(chat, 7, "The bells rang.");

    const branched = await api("POST", `/api/chats/${chat.id}/messages/${(await messageAt(chat, 5)).id}/branch`, {});
    const branch = ((await branched.json()) as { chat: Chat }).chat;
    expect(await transcript(branch)).toHaveLength(4);
    expect(await chapters(branch)).toMatchObject([{ start_position: 1, end_position: 4, summary: first.summary }]);

    expect((await api("DELETE", `/api/chats/${chat.id}`)).status).toBe(200);
    expect(await chapters(branch)).toHaveLength(1);
  });
});

describe("editing chapters", () => {
  test("a summary can be edited by hand, rewritten by the model, and deleted with every later chapter", async () => {
    const chat = await seedChat();
    await play(chat, ["The harbor wakes.", "The ferry sails."], ["I board the ferry."]);
    const first = await summarize(chat, 1, "The harbor woke.");
    await summarize(chat, 3, "Sable boarded.");

    const edited = await api("PATCH", `/api/chats/${chat.id}/chapters/${first.id}`, { summary: "  Hand-written.  " });
    expect(((await edited.json()) as { chapter: Chapter }).chapter).toMatchObject({ summary: "Hand-written.", edited: true });

    replies.push("The harbor woke at dawn.");
    const rewritten = await api("POST", `/api/chats/${chat.id}/chapters/${first.id}/regenerate`, {});
    expect(rewritten.status).toBe(200);
    expect(((await rewritten.json()) as { chapter: Chapter }).chapter).toMatchObject({
      start_position: 1,
      end_position: 1,
      summary: "The harbor woke at dawn.",
      edited: false,
    });

    const removed = await api("DELETE", `/api/chats/${chat.id}/chapters/${first.id}`);
    expect(((await removed.json()) as { chapters: Chapter[] }).chapters).toEqual([]);
    expect((await api("DELETE", `/api/chats/${chat.id}/chapters/${first.id}`)).status).toBe(404);
  });
});

describe("summary calls", () => {
  test("one summary runs per chat, and one whose messages changed during the call saves nothing", async () => {
    const chat = await seedChat();
    await play(chat, ["The harbor wakes."], []);
    const held = Promise.withResolvers<void>();
    gate = held.promise;
    try {
      replies.push("The harbor woke.");
      arrived = Promise.withResolvers<void>();
      const pending = api("POST", `/api/chats/${chat.id}/chapters`, { through_message_id: (await messageAt(chat, 1)).id });
      await arrived.promise;

      const second = await api("POST", `/api/chats/${chat.id}/chapters`, { through_message_id: (await messageAt(chat, 1)).id });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("busy");

      expect((await api("PATCH", `/api/chats/${chat.id}/messages/${(await messageAt(chat, 1)).id}`, { content: "Night." })).status).toBe(200);
      held.resolve();
      const stale = await pending;
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { code: string }).code).toBe("conflict");
      expect(await chapters(chat)).toEqual([]);
    } finally {
      gate = null;
    }
  });

  test("a failed summary saves nothing and reports a sanitized error", async () => {
    const chat = await seedChat();
    await play(chat, ["The harbor wakes."], []);
    replies.push({ status: 500 });
    const failed = await api("POST", `/api/chats/${chat.id}/chapters`, { through_message_id: (await messageAt(chat, 1)).id });
    expect(failed.status).toBe(502);
    const body = (await failed.json()) as { code: string; error: string };
    expect(body.code).toBe("upstream_unavailable");
    expect(body.error).not.toContain("boom");
    expect(await chapters(chat)).toEqual([]);
  });
});
