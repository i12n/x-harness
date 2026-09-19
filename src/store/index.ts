import { loadAppConfig } from "../config/config.js";
import { createPool } from "../db/pool.js";
import { InMemoryRepositoryStore } from "./inMemoryRepositoryStore.js";
import { InMemoryEventStore } from "./inMemoryEventStore.js";
import { InMemoryConversationStore } from "./inMemoryConversationStore.js";
import { InMemoryDeliveryStore } from "./inMemoryDeliveryStore.js";
import { InMemoryExecutionStore } from "./inMemoryExecutionStore.js";
import { InMemoryProblemStore } from "./inMemoryProblemStore.js";
import { InMemoryRunStore } from "./inMemoryRunStore.js";
import { InMemorySpecificationStore } from "./inMemorySpecificationStore.js";
import { InMemorySpecificationPlanStore } from "./inMemorySpecificationPlanStore.js";
import { InMemoryTaskDependencyStore } from "./inMemoryTaskDependencyStore.js";
import { InMemoryTaskStore } from "./inMemoryTaskStore.js";
import { PostgresEventStore } from "./postgresEventStore.js";
import { PostgresConversationStore } from "./postgresConversationStore.js";
import { PostgresDeliveryStore } from "./postgresDeliveryStore.js";
import { PostgresExecutionStore } from "./postgresExecutionStore.js";
import { PostgresRepositoryStore } from "./postgresRepositoryStore.js";
import { PostgresProblemStore } from "./postgresProblemStore.js";
import { PostgresRunStore } from "./postgresRunStore.js";
import { PostgresSpecificationStore } from "./postgresSpecificationStore.js";
import { PostgresSpecificationPlanStore } from "./postgresSpecificationPlanStore.js";
import { PostgresTaskDependencyStore } from "./postgresTaskDependencyStore.js";
import { PostgresTaskStore } from "./postgresTaskStore.js";
import type { RepositoryStore } from "./repositoryStore.js";
import type { RunStore } from "./runStore.js";
import type { TaskStore } from "./taskStore.js";
import type { EventStore } from "./eventStore.js";
import type { ConversationStore } from "./conversationStore.js";
import type { DeliveryStore } from "./deliveryStore.js";
import type { ExecutionStore } from "./executionStore.js";
import type { ProblemStore } from "./problemStore.js";
import type { SpecificationStore } from "./specificationStore.js";
import type { SpecificationPlanStore } from "./specificationPlanStore.js";
import type { TaskDependencyStore } from "./taskDependencyStore.js";

export type { RepositoryStore } from "./repositoryStore.js";
export type { TaskStore } from "./taskStore.js";
export type { RunStore } from "./runStore.js";
export type { EventStore } from "./eventStore.js";
export type { ConversationStore } from "./conversationStore.js";
export type { DeliveryStore } from "./deliveryStore.js";
export type { ExecutionStore } from "./executionStore.js";
export type { ProblemStore } from "./problemStore.js";
export type { SpecificationStore } from "./specificationStore.js";
export type { SpecificationPlanStore } from "./specificationPlanStore.js";
export type { TaskDependencyStore } from "./taskDependencyStore.js";
export type { Repository } from "../domain/repository.js";
export type { Task, TaskStatus } from "../domain/task.js";
export type { Run, RunStatus } from "../domain/run.js";
export type { EventRecord } from "../domain/event.js";
export type {
  Specification,
  SpecificationStatus,
  SpecificationTarget,
} from "../domain/specification.js";
export type {
  SpecificationPlanItem,
  CreateSpecificationPlanItemInput,
} from "../domain/specificationPlan.js";
export type {
  TaskDependency,
  AddTaskDependencyInput,
} from "../domain/taskDependency.js";
export type {
  Delivery,
  DeliveryStatus,
  Release,
  ReleaseStatus,
} from "../domain/delivery.js";
export type {
  Conversation,
  ConversationMessage,
  ConversationStatus,
  SubjectType,
} from "../domain/conversation.js";
export type { ExecutionRecord, ExecutionStatus } from "../domain/execution.js";
export type {
  Problem,
  ProblemStatus,
  Clarification,
  ClarificationType,
} from "../domain/problem.js";

export interface StoreHandle {
  repositories: RepositoryStore;
  tasks: TaskStore;
  runs: RunStore;
  events: EventStore;
  problems: ProblemStore;
  specifications: SpecificationStore;
  specificationPlans: SpecificationPlanStore;
  taskDependencies: TaskDependencyStore;
  deliveries: DeliveryStore;
  executions: ExecutionStore;
  conversations: ConversationStore;
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
      problems: new InMemoryProblemStore(),
      specifications: new InMemorySpecificationStore(),
      specificationPlans: new InMemorySpecificationPlanStore(),
      taskDependencies: new InMemoryTaskDependencyStore(),
      deliveries: new InMemoryDeliveryStore(),
      executions: new InMemoryExecutionStore(),
      conversations: new InMemoryConversationStore(),
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
    problems: new PostgresProblemStore(pool),
    specifications: new PostgresSpecificationStore(pool),
    specificationPlans: new PostgresSpecificationPlanStore(pool),
    taskDependencies: new PostgresTaskDependencyStore(pool),
    deliveries: new PostgresDeliveryStore(pool),
    executions: new PostgresExecutionStore(pool),
    conversations: new PostgresConversationStore(pool),
    close: async () => {
      await pool.end();
    },
  };
}
