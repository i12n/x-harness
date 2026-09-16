import type {
  CreateExecutionInput,
  ExecutionRecord,
  ExecutionStatus,
} from "../domain/execution.js";

export interface ExecutionListFilter {
  runId?: string;
  statuses?: ExecutionStatus[];
}

export interface UpdateExecutionInput {
  status?: ExecutionStatus;
  containerId?: string;
  error?: unknown;
  startedAt?: string;
  finishedAt?: string;
  cleanedAt?: string;
}

/** Persistence contract for execution lifecycle records. */
export interface ExecutionStore {
  createExecution(input: CreateExecutionInput): Promise<ExecutionRecord>;
  findExecution(id: string): Promise<ExecutionRecord>;
  findLatestByRunId(runId: string): Promise<ExecutionRecord | undefined>;
  listExecutions(filter?: ExecutionListFilter): Promise<ExecutionRecord[]>;
  updateExecution(id: string, update: UpdateExecutionInput): Promise<ExecutionRecord>;
}
