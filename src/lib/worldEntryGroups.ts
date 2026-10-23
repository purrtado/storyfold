import type { WorldEntryKind } from "../../shared/domain";

export const worldEntryGroups: ReadonlyArray<{ kind: WorldEntryKind; label: string }> = [
  { kind: "location", label: "Locations" },
  { kind: "lore", label: "Lore" },
  { kind: "scene", label: "Opening scenes" },
];
