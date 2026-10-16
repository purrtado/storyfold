import type { Campaign, CampaignStateCategory, CampaignStateItem, Session } from "../../shared/domain";

export function isActiveCampaignSession(campaign: Campaign, session: Session) {
  return session.id === campaign.active_session_id && !session.closed_at;
}
export function sortCampaignStateItems(items: CampaignStateItem[], category: CampaignStateCategory) {
  return items
    .filter((item) => item.category === category)
    .sort((a, b) => category === "journal"
      ? a.created_at.localeCompare(b.created_at)
      : b.updated_at.localeCompare(a.updated_at));
}

export type CampaignSessionDetails = { campaign: Campaign; session: Session };

export function updateCampaignSessionCache(
  current: Record<string, CampaignSessionDetails>,
  sessionId: string,
  details: CampaignSessionDetails,
) {
  const next = { ...current };
  for (const [cachedSessionId, cached] of Object.entries(current)) {
    if (cached.campaign.id === details.campaign.id) {
      next[cachedSessionId] = { ...cached, campaign: details.campaign };
    }
  }
  next[sessionId] = details;
  return next;
}

