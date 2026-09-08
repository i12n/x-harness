import { loadAppConfig } from "../config/config.js";
import { createPool } from "../db/pool.js";
import { InMemoryRepositoryStore } from "./inMemoryRepositoryStore.js";
import { InMemoryTaskStore } from "./inMemoryTaskStore.js";
import { PostgresRepositoryStore } from "./postgresRepositoryStore.js";
import { PostgresTaskStore } from "./postgresTaskStore.js";
import type { RepositoryStore } from "./repositoryStore.js";
import type { TaskStore } from "./taskStore.js";

export type { RepositoryStore } from "./repositoryStore.js";
export type { TaskStore } from "./taskStore.js";
export type { Repository } from "../domain/repository.js";
export type { Task, TaskStatus } from "../domain/task.js";

export interface StoreHandle {
  repositories: RepositoryStore;
  tasks: TaskStore;
  close(): Promise<void>;
}

/**
 * Open both stores selected by `AI_STORAGE` (default: `postgres`).
 * `memory` is for tests and local demos without a running database.
 */
export async function openStores(): Promise<StoreHandle> {
  const kind = (process.env.AI_STORAGE ?? "postgres").toLowerCase();
  if (kind === "memory") {
    return {
      repositories: new InMemoryRepositoryStore(),
      tasks: new InMemoryTaskStore(),
      close: async () => {},
    };
  }
  if (kind !== "postgres") {
    throw new Error(`unknown AI_STORAGE '${kind}' (use postgres or memory)`);
  }
  const config = loadAppConfig();
  const pool = createPool(config.dbUrl);
  return {
    repositories: new PostgresRepositoryStore(pool),
    tasks: new PostgresTaskStore(pool),
    close: async () => {
      await pool.end();
    },
  };
}
