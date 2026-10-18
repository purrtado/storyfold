import { afterEach, expect, test } from "bun:test";
import {
  createCampaignRelationship,
  createCampaignRelationshipEvent,
  createCampaignRelationshipSubject,
  createCampaignSession,
  createCampaignStateItem,
  deleteCampaignRelationship,
  deleteCampaignStateItem,
  fetchCampaignRelationshipEvents,
  fetchCampaignRelationships,
  fetchCampaignSessions,
  fetchCampaignState,
  forkSession,
  updateCampaignRelationship,
  updateCampaignStateItem,
  type CampaignFork,
} from "./storyApi";
import type { CampaignStateItem, Relationship, RelationshipDocument, RelationshipEvent, RelationshipSubject, Session } from "../../shared/domain";

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
test("relationship API sends directed endpoints, revisions, and session-bound event descriptions", async () => {
  const document: RelationshipDocument = {
    how_met: "At the river crossing.",
    status: "Uneasy allies",
    stats: { trust: { value: 2, min: 0, max: 5 } },
    known_facts: ["Captain follows the old road."],
    sections: [{ id: "note-1", label: "Promises", type: "list", value: ["Return before dawn."] }],
  };
  const subject: RelationshipSubject = { id: "local-npc/1", name: "Captain", kind: "local_character" };
  const relationship: Relationship = {
    id: "relationship/1",
    campaign_id: "campaign/1",
    source_id: "character:protagonist",
    target_id: subject.id,
    document,
    revision: 1,
    created_at: "2026-10-03T10:00:00.000Z",
    updated_at: "2026-10-03T10:00:00.000Z",
  };
  const event: RelationshipEvent = {
    id: "event/1",
    relationship_id: relationship.id,
    campaign_id: relationship.campaign_id,
    session_id: "session/1",
    description: "The captain returned the map.",
    created_at: "2026-10-03T11:00:00.000Z",
  };
  const requests = useResponses([
    { subjects: [subject], relationships: [relationship] },
    { subject },
    { relationship },
    { relationship: { ...relationship, revision: 2 } },
    { ok: true },
    { events: [event] },
    { event: { ...event, id: "event/2", description: "The party agreed to travel together." } },
  ]);

  expect(await fetchCampaignRelationships("campaign/1")).toEqual({ subjects: [subject], relationships: [relationship] });
  expect(await createCampaignRelationshipSubject("campaign/1", subject.name)).toEqual(subject);
  expect(await createCampaignRelationship("campaign/1", {
    source_id: relationship.source_id,
    target_id: relationship.target_id,
    document,
  })).toEqual(relationship);
  expect(await updateCampaignRelationship("campaign/1", relationship.id, { document, revision: 1 })).toMatchObject({
    id: relationship.id,
    revision: 2,
  });
  expect(await deleteCampaignRelationship("campaign/1", relationship.id)).toEqual({ ok: true });
  expect(await fetchCampaignRelationshipEvents("campaign/1", relationship.id)).toEqual([event]);
  expect(await createCampaignRelationshipEvent("campaign/1", relationship.id, "The party agreed to travel together.")).toMatchObject({
    session_id: event.session_id,
    description: "The party agreed to travel together.",
  });

  expect(requests.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
    ["/api/campaigns/campaign%2F1/relationships", "GET"],
    ["/api/campaigns/campaign%2F1/relationship-subjects", "POST"],
    ["/api/campaigns/campaign%2F1/relationships", "POST"],
    ["/api/campaigns/campaign%2F1/relationships/relationship%2F1", "PATCH"],
    ["/api/campaigns/campaign%2F1/relationships/relationship%2F1", "DELETE"],
    ["/api/campaigns/campaign%2F1/relationships/relationship%2F1/events", "GET"],
    ["/api/campaigns/campaign%2F1/relationships/relationship%2F1/events", "POST"],
  ]);
  expect(JSON.parse(requests[2]?.init?.body as string)).toEqual({
    source_id: relationship.source_id,
    target_id: relationship.target_id,
    document,
  });
  expect(JSON.parse(requests[3]?.init?.body as string)).toEqual({ document, revision: 1 });
  expect(JSON.parse(requests[6]?.init?.body as string)).toEqual({ description: "The party agreed to travel together." });
});
