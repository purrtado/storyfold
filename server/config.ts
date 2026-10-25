import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigDirectory(): string {
  const override = process.env.STORYFOLD_CONFIG_DIR?.trim();
  if (override && override.startsWith("/")) return override;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const root = xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config");
  return join(root, "storyfold");
}

export const DATABASE_FILENAME = "storyfold.db";

/** Directory holding storyfold.db; STORYFOLD_DATA_DIR overrides, else the config dir. */
export function defaultDataDirectory(): string {
  const override = process.env.STORYFOLD_DATA_DIR?.trim();
  if (override && override.startsWith("/")) return override;
  return defaultConfigDirectory();
}

export function defaultDatabasePath(): string {
  return join(defaultDataDirectory(), DATABASE_FILENAME);
}
