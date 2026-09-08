import { loadAppConfig } from "../config/config.js";
import { createPool } from "../db/pool.js";
import { InMemoryRepositoryStore } from "./inMemoryRepositoryStore.js";
import { PostgresRepositoryStore } from "./postgresRepositoryStore.js";
import type { RepositoryStore } from "./repositoryStore.js";

export type { RepositoryStore } from "./repositoryStore.js";
export type { Repository } from "../domain/repository.js";

export interface RepositoryStoreHandle {
  store: RepositoryStore;
  close(): Promise<void>;
}

/**
 * Open the store selected by `AI_STORAGE` (default: `postgres`).
 * `memory` is for tests and local demos without a running database.
 */
export async function openRepositoryStore(): Promise<RepositoryStoreHandle> {
  const kind = (process.env.AI_STORAGE ?? "postgres").toLowerCase();
  if (kind === "memory") {
    return { store: new InMemoryRepositoryStore(), close: async () => {} };
  }
  if (kind !== "postgres") {
    throw new Error(`unknown AI_STORAGE '${kind}' (use postgres or memory)`);
  }
  const config = loadAppConfig();
  const pool = createPool(config.dbUrl);
  return {
    store: new PostgresRepositoryStore(pool),
    close: async () => {
      await pool.end();
    },
  };
}
