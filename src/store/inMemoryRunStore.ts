import { ACTIVE_RUN_STATUSES, buildRun, isTerminalRunStatus } from "../domain/run.js";
import type { CreateRunInput, Run, RunStatus } from "../domain/run.js";
import {
  DuplicateActiveRunError,
  RunConflictError,
  RunNotFoundError,
} from "../errors.js";
import { RunNotCancellableError } from "../errors.js";
import type { CompleteRunInput, RunListFilter, RunStore } from "./runStore.js";

/** Non-persistent run store, used by tests and memory-mode demos. */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Run>();

  async createRun(input: CreateRunInput): Promise<Run> {
    const run = buildRun(input);
    // Mirrors runs_active_task_idx (migrations/011): one active run per task.
    if ((ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(run.status)) {
      const active = [...this.runs.values()].some(
        (existing) =>
          existing.taskId === run.taskId &&
          (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(existing.status),
      );
      if (active) {
        throw new DuplicateActiveRunError(run.taskId);
      }
    }
    this.runs.set(run.id, run);
    return run;
  }

  async findRun(id: string): Promise<Run> {
    const run = this.runs.get(id);
    if (!run) {
      throw new RunNotFoundError(id);
    }
    return run;
  }

  async listRuns(filter: RunListFilter = {}): Promise<Run[]> {
    return [...this.runs.values()]
      .filter(
        (run) =>
          (filter.taskId === undefined || run.taskId === filter.taskId) &&
          (filter.statuses === undefined ||
            filter.statuses.length === 0 ||
            filter.statuses.includes(run.status)) &&
          (filter.cancelRequested === undefined ||
            (filter.cancelRequested
              ? Boolean(run.cancelRequestedAt)
              : !run.cancelRequestedAt)),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async claimRun(id: string, workerId: string, leaseUntil: string): Promise<Run> {
    const current = await this.findRun(id);
    if (current.status !== "QUEUED") {
      throw new RunConflictError(id, `status is ${current.status}`);
    }
    return this.replace(id, { ...current, status: "STARTING", workerId, leaseUntil });
  }

  async markRunning(id: string, startedAt = new Date().toISOString()): Promise<Run> {
    const current = await this.findRun(id);
    return this.replace(id, { ...current, status: "RUNNING", startedAt });
  }

  async updateRunStatus(id: string, status: RunStatus): Promise<Run> {
    const current = await this.findRun(id);
    return this.replace(id, { ...current, status });
  }

  async touchLease(id: string, leaseUntil: string): Promise<Run> {
    const current = await this.findRun(id);
    return this.replace(id, { ...current, leaseUntil });
  }

  async requestCancel(id: string, requestedBy: string): Promise<Run> {
    const current = await this.findRun(id);
    if (isTerminalRunStatus(current.status)) {
      throw new RunNotCancellableError(id, current.status);
    }
    if (current.cancelRequestedAt) {
      return current;
    }
    return this.replace(id, {
      ...current,
      cancelRequestedAt: new Date().toISOString(),
      cancelRequestedBy: requestedBy,
    });
  }

  async completeRun(id: string, input: CompleteRunInput): Promise<Run> {
    const current = await this.findRun(id);
    return this.replace(id, {
      ...current,
      status: input.status,
      exitCode: input.exitCode ?? current.exitCode,
      result: input.result ?? current.result,
      error: input.error ?? current.error,
      finishedAt: input.finishedAt ?? new Date().toISOString(),
    });
  }

  private replace(id: string, run: Run): Run {
    this.runs.set(id, run);
    return run;
  }
}
