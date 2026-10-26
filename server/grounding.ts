import type { Database } from "bun:sqlite";
import type { Character, Chat, StatDefinition, World, WorldEntry } from "../shared/domain";
import { narratorSystemPrompt, type RelationshipPrompt } from "../shared/narration";
import { getWorld, listStatDefinitions, listWorldCharacters, listWorldEntries } from "./worlds";
import { listPromptCards } from "./promptCards";
import { relationshipNarrationContext } from "./relationships";

/** Everything the narrator knows for one chat, read from the world as it is right now. */
export interface ChatGrounding {
  world: World;
  /** Locations and lore; scenes are opening templates and never reach the narrator. */
  entries: WorldEntry[];
  stats: StatDefinition[];
  protagonist: Character;
  /** Every world character but the protagonist, in creation order. */
  cast: Character[];
  relationships: RelationshipPrompt[];
}

export function chatGrounding(db: Database, chat: Pick<Chat, "world_id" | "protagonist_id">): ChatGrounding {
  const world = getWorld(db, chat.world_id)!;
  const characters = listWorldCharacters(db, world.id);
  return {
    world,
    entries: listWorldEntries(db, world.id).filter((entry) => entry.kind !== "scene"),
    stats: listStatDefinitions(db, world.id),
    protagonist: characters.find((character) => character.id === chat.protagonist_id)!,
    cast: characters.filter((character) => character.id !== chat.protagonist_id),
    relationships: relationshipNarrationContext(db, world.id, characters),
  };
}

/** The saved prompt cards filled from the live world and the chat's opening. */
export function chatSystemPrompt(
  db: Database,
  chat: Pick<Chat, "world_id" | "protagonist_id" | "opening">,
  hasHistory: boolean,
): string {
  const grounding = chatGrounding(db, chat);
  return narratorSystemPrompt(listPromptCards(db), {
    world: { name: grounding.world.name, setting_brief: grounding.world.setting_brief, entries: grounding.entries },
    opening: chat.opening,
    stats: grounding.stats,
    protagonist: grounding.protagonist,
    cast: grounding.cast,
    relationships: grounding.relationships,
    has_history: hasHistory,
  });
}
