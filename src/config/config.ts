import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { HarnessError } from "../errors.js";

export interface AppConfig {
  dbUrl: string;
}

/**
 * Load configuration. `DATABASE_URL` wins over `config/config.yaml`;
 * `AI_CONFIG_PATH` overrides the config file location.
 */
export function loadAppConfig(): AppConfig {
  const dbUrl =
    process.env.DATABASE_URL?.trim() || readFileDbUrl();
  if (!dbUrl) {
    throw new HarnessError(
      "DATABASE_URL is not set and config/config.yaml has no db.url (or run with AI_STORAGE=memory)",
    );
  }
  return { dbUrl };
}

function readFileDbUrl(): string | undefined {
  const configPath =
    process.env.AI_CONFIG_PATH ??
    resolve(process.cwd(), "config", "config.yaml");
  if (!existsSync(configPath)) {
    return undefined;
  }
  const doc = YAML.parse(readFileSync(configPath, "utf8")) as
    | { db?: { url?: unknown } }
    | null
    | undefined;
  const url = doc?.db?.url;
  return typeof url === "string" && url.trim() ? url.trim() : undefined;
}
