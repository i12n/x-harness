import { ValidationError } from "../errors.js";
import type { ExecutionMount } from "../execution/mounts.js";

/** Execution lifecycle (docs/remote-execution-isolation.md, TASK-901). */
export const EXECUTION_STATUSES = [
  "CREATING",
  "CREATED",
  "STARTING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "LOST",
  "CLEANING",
  "CLEANED",
  "CLEANUP_FAILED",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface ExecutionRecord {
  id: string;
  runId: string;
  driver: string;
  status: ExecutionStatus;
  containerId?: string;
  workspacePath: string;
  workdir: string;
  profileName?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cleanedAt?: string;
  error?: unknown;
  /** TASK-1006: workspaces mounted into the execution environment. */
  mounts?: ExecutionMount[];
}

export interface CreateExecutionInput {
  id: string;
  runId: string;
  driver: string;
  workspacePath: string;
  workdir: string;
  profileName?: string;
  status?: ExecutionStatus;
  mounts?: ExecutionMount[];
}

export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return typeof value === "string" && (EXECUTION_STATUSES as readonly string[]).includes(value);
}

export function buildExecutionRecord(input: CreateExecutionInput): ExecutionRecord {
  const status = input.status ?? "CREATING";
  if (!isExecutionStatus(status)) {
    throw new ValidationError(`invalid execution status: ${String(status)}`);
  }
  return {
    id: input.id,
    runId: input.runId,
    driver: input.driver,
    status,
    containerId: undefined,
    workspacePath: input.workspacePath,
    workdir: input.workdir,
    profileName: input.profileName,
    mounts: input.mounts,
    createdAt: new Date().toISOString(),
  };
}
