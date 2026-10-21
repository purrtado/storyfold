import { expect, test } from "bun:test";
import type { Campaign, CampaignStateItem, Session } from "../../shared/domain";
import { isActiveCampaignSession, sortCampaignStateItems, updateCampaignSessionCache } from "./campaignLifecycle";

const campaign = { active_session_id: "session-2" } as Campaign;

function journal(id: string, created_at: string, updated_at: string): CampaignStateItem {
  return {
    id,
    campaign_id: "campaign-1",
    category: "journal",
    subject: id,
    subject_kind: null,
    subject_id: null,
    content: id,
    created_at,
    updated_at,
  };
}

test("only the open active session is writable", () => {
  expect(isActiveCampaignSession(campaign, { id: "session-2", closed_at: null } as Session)).toBe(true);
  expect(isActiveCampaignSession(campaign, { id: "session-2", closed_at: "2026-10-01T10:00:00.000Z" } as Session)).toBe(false);
  expect(isActiveCampaignSession(campaign, { id: "session-1", closed_at: "2026-09-01T10:00:00.000Z" } as Session)).toBe(false);
});

test("journal state stays chronological when an older entry is edited later", () => {
  const entries = [
    journal("later", "2026-10-02T10:00:00.000Z", "2026-10-02T10:00:00.000Z"),
    journal("edited-early", "2026-10-01T10:00:00.000Z", "2026-10-03T10:00:00.000Z"),
  ];

  expect(sortCampaignStateItems(entries, "journal").map((item) => item.id)).toEqual([
    "edited-early",
    "later",
  ]);
});

test("session synchronization refreshes every cached detail for its campaign", () => {
  const previousCampaign = { id: "campaign-a", active_session_id: "session-1" } as Campaign;
  const nextCampaign = { ...previousCampaign, active_session_id: "session-3" };
  const otherCampaign = { id: "campaign-b", active_session_id: "session-b" } as Campaign;
  const previousSession = { id: "session-1", campaign_id: "campaign-a" } as Session;
  const olderSession = { id: "session-2", campaign_id: "campaign-a" } as Session;
  const unrelatedSession = { id: "session-b", campaign_id: "campaign-b" } as Session;
  const nextSession = { id: "session-3", campaign_id: "campaign-a" } as Session;
  const current = {
    "session-1": { campaign: previousCampaign, session: previousSession },
    "session-2": { campaign: previousCampaign, session: olderSession },
    "session-b": { campaign: otherCampaign, session: unrelatedSession },
  };

  const updated = updateCampaignSessionCache(current, "session-3", {
    campaign: nextCampaign,
    session: nextSession,
  });

  expect(updated["session-1"]?.campaign.active_session_id).toBe("session-3");
  expect(updated["session-2"]?.campaign.active_session_id).toBe("session-3");
  expect(updated["session-b"]?.campaign.active_session_id).toBe("session-b");
  expect(updated["session-3"]?.session).toBe(nextSession);
  expect(current["session-1"]?.campaign.active_session_id).toBe("session-1");
});
