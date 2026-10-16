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

