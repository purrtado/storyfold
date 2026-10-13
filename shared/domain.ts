/**
 * Wire/domain types shared between the Bun server and the browser.
 * JSON APIs are snake_case with ISO timestamps; ids are server-generated text.
 */

export interface WorldSnapshot {
  name: string;
  setting_brief: string;
  suggested_starting_situation: string;
}

export interface PersonaSnapshot {
  name: string;
  description: string;
}

export interface World {
  id: string;
  name: string;
  setting_brief: string;
  suggested_starting_situation: string;
  created_at: string;
  updated_at: string;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  world_id: string;
  persona_id: string;
  world_snapshot: WorldSnapshot;
  persona_snapshot: PersonaSnapshot;
  starting_situation: string;
  active_session_id: string;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  campaign_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant";

export type MessageStatus = "pending" | "complete" | "interrupted" | "failed";

export interface Message {
  id: string;
  session_id: string;
  position: number;
  role: MessageRole;
  speaker_name: string;
  content: string;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
}
