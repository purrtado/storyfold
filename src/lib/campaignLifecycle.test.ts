import { expect, test } from "bun:test";
import type { Campaign, CampaignStateItem, Session } from "../../shared/domain";
import { isActiveCampaignSession, sortCampaignStateItems } from "./campaignLifecycle";

const campaign = { active_session_id: "session-2" } as Campaign;

function journal(id: string, created_at: string, updated_at: string): CampaignStateItem {
  return {
    id,
    campaign_id: "campaign-1",
    category: "journal",
    subject: id,
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
