import { afterEach, expect, test } from "bun:test";
import {
  createCampaignSession,
  createCampaignStateItem,
  deleteCampaignStateItem,
  fetchCampaignSessions,
  fetchCampaignState,
  forkSession,
  updateCampaignStateItem,
  type CampaignFork,
} from "./storyApi";
import type { CampaignStateItem, Session } from "../../shared/domain";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function useResponses(payloads: unknown[]) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = Object.assign(async (
    input: RequestInfo | URL,
    init?: Parameters<typeof fetch>[1],
  ) => {
    requests.push({ url: String(input), init: init as RequestInit | undefined });
    const payload = payloads.shift();
    return new Response(JSON.stringify(payload), { status: 200 });
  }, { preconnect: originalFetch.preconnect });
  return requests;
}

const stateItem: CampaignStateItem = {
  id: "state-1",
  campaign_id: "campaign/1",
  category: "journal",
  subject: "A promise",
  subject_kind: "entry",
  subject_id: "entry-4",
  content: "Mira promised to return.",
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-01T10:00:00.000Z",
};

const session: Session = {
  id: "session-2",
  campaign_id: "campaign/1",
  title: "After the storm",
  handoff: "The party reached the northern pass.",
  closed_at: null,
  created_at: "2026-10-02T10:00:00.000Z",
  updated_at: "2026-10-02T10:00:00.000Z",
};

test("campaign state API unwraps lists and sends create, edit, and delete requests", async () => {
  const requests = useResponses([
    { items: [stateItem] },
    stateItem,
    { ...stateItem, content: "Mira kept her promise." },
    { ok: true },
  ]);
  const input = {
    category: "journal" as const,
    subject: stateItem.subject,
    subject_kind: stateItem.subject_kind,
    subject_id: stateItem.subject_id,
    content: stateItem.content,
  };

  expect(await fetchCampaignState("campaign/1")).toEqual([stateItem]);
  expect(await createCampaignStateItem("campaign/1", input)).toEqual(stateItem);
  expect(await updateCampaignStateItem("campaign/1", stateItem.id, input)).toMatchObject({
    id: stateItem.id,
    content: "Mira kept her promise.",
  });
  expect(await deleteCampaignStateItem("campaign/1", stateItem.id)).toEqual({ ok: true });

  expect(requests.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
    ["/api/campaigns/campaign%2F1/state", "GET"],
    ["/api/campaigns/campaign%2F1/state", "POST"],
    ["/api/campaigns/campaign%2F1/state/state-1", "PATCH"],
    ["/api/campaigns/campaign%2F1/state/state-1", "DELETE"],
  ]);
  expect(JSON.parse(requests[1]?.init?.body as string)).toEqual(input);
  expect(JSON.parse(requests[2]?.init?.body as string)).toEqual(input);
});

test("session history, transition, and fork unwrap their endpoint envelopes", async () => {
  const fork: CampaignFork = {
    campaign: {
      id: "campaign-2",
      name: "The northern road",
      world_id: "world-1",
      protagonist_id: "character-1",
      world_snapshot: {} as CampaignFork["campaign"]["world_snapshot"],
      protagonist_snapshot: {} as CampaignFork["campaign"]["protagonist_snapshot"],
      cast: [],
      starting_situation: "",
      active_session_id: "session-3",
      forked_from_campaign_id: "campaign/1",
      forked_from_session_id: "session-1",
      created_at: "2026-10-03T10:00:00.000Z",
      updated_at: "2026-10-03T10:00:00.000Z",
    },
    session: { ...session, id: "session-3", campaign_id: "campaign-2" },
  };
  const requests = useResponses([
    { sessions: [session] },
    { session },
    fork,
  ]);

  expect(await fetchCampaignSessions("campaign/1")).toEqual([session]);
  expect(await createCampaignSession("campaign/1", {
    title: session.title,
    handoff: session.handoff ?? "",
  })).toEqual(session);
  expect(await forkSession("session-1", "The northern road")).toEqual(fork);

  expect(requests.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
    ["/api/campaigns/campaign%2F1/sessions", "GET"],
    ["/api/campaigns/campaign%2F1/sessions", "POST"],
    ["/api/sessions/session-1/fork", "POST"],
  ]);
  expect(JSON.parse(requests[1]?.init?.body as string)).toEqual({
    title: session.title,
    handoff: session.handoff,
  });
  expect(JSON.parse(requests[2]?.init?.body as string)).toEqual({ name: "The northern road" });
});
