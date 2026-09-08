import { loadAppConfig } from "../config/config.js";
import { createPool } from "../db/pool.js";
import { InMemoryRepositoryStore } from "./inMemoryRepositoryStore.js";
import { InMemoryEventStore } from "./inMemoryEventStore.js";
import { InMemoryRunStore } from "./inMemoryRunStore.js";
import { InMemoryTaskStore } from "./inMemoryTaskStore.js";
import { PostgresEventStore } from "./postgresEventStore.js";
import { PostgresRepositoryStore } from "./postgresRepositoryStore.js";
import { PostgresRunStore } from "./postgresRunStore.js";
import { PostgresTaskStore } from "./postgresTaskStore.js";
import type { RepositoryStore } from "./repositoryStore.js";
import type { RunStore } from "./runStore.js";
import type { TaskStore } from "./taskStore.js";
import type { EventStore } from "./eventStore.js";

export type { RepositoryStore } from "./repositoryStore.js";
export type { TaskStore } from "./taskStore.js";
export type { RunStore } from "./runStore.js";
export type { EventStore } from "./eventStore.js";
export type { Repository } from "../domain/repository.js";
export type { Task, TaskStatus } from "../domain/task.js";
export type { Run, RunStatus } from "../domain/run.js";
export type { EventRecord } from "../domain/event.js";

export interface StoreHandle {
  repositories: RepositoryStore;
  tasks: TaskStore;
  runs: RunStore;
  events: EventStore;
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
      runs: new InMemoryRunStore(),
      events: new InMemoryEventStore(),
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
    runs: new PostgresRunStore(pool),
    events: new PostgresEventStore(pool),
    close: async () => {
      await pool.end();
    },
  };
}
