import type { CreateRunInput, Run, RunStatus } from "../domain/run.js";

export interface RunListFilter {
  taskId?: string;
  statuses?: RunStatus[];
}

export interface CompleteRunInput {
  status: RunStatus;
  exitCode?: number | null;
  result?: unknown;
  error?: unknown;
  finishedAt?: string;
}

/** Persistence contract for runs, including claim/heartbeat semantics. */
export interface RunStore {
  createRun(input: CreateRunInput): Promise<Run>;
  findRun(id: string): Promise<Run>;
  listRuns(filter?: RunListFilter): Promise<Run[]>;
  /** QUEUED -> STARTING, bound to a worker with a lease. */
  claimRun(id: string, workerId: string, leaseUntil: string): Promise<Run>;
  /** STARTING -> RUNNING, records startedAt. */
  markRunning(id: string, startedAt?: string): Promise<Run>;
  /** Generic status change used for VERIFYING (and others). */
  updateRunStatus(id: string, status: RunStatus): Promise<Run>;
  /** Refresh the lease while a worker is alive. */
  touchLease(id: string, leaseUntil: string): Promise<Run>;
  /** Terminal status + result/error/exit code. */
  completeRun(id: string, input: CompleteRunInput): Promise<Run>;
}
