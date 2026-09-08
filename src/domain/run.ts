import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";

export const RUN_STATUSES = [
  "QUEUED",
  "STARTING",
  "RUNNING",
  "VERIFYING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "LOST",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "QUEUED",
  "STARTING",
  "RUNNING",
  "VERIFYING",
];

/** One attempt at executing a task. */
export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  attempt: number;
  agent: string;
  engine: string;
  workerId?: string;
  leaseUntil?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  result?: unknown;
  error?: unknown;
  createdAt: string;
}

export interface CreateRunInput {
  id?: string;
  taskId: string;
  attempt: number;
  agent: string;
  engine: string;
  status?: RunStatus;
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** Build a Run with QUEUED status and generated id by default. */
export function buildRun(input: CreateRunInput): Run {
  const status = input.status ?? "QUEUED";
  if (!isRunStatus(status)) {
    throw new ValidationError(`invalid run status: ${String(status)}`);
  }
  return {
    id: input.id?.trim() || makeId("run"),
    taskId: input.taskId,
    status,
    attempt: input.attempt,
    agent: input.agent,
    engine: input.engine,
    createdAt: new Date().toISOString(),
  };
}
