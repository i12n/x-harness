import { buildExecutionRecord } from "../domain/execution.js";
import type {
  CreateExecutionInput,
  ExecutionRecord,
} from "../domain/execution.js";
import { ExecutionNotFoundError } from "../errors.js";
import type {
  ExecutionListFilter,
  ExecutionStore,
  UpdateExecutionInput,
} from "./executionStore.js";

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly executions = new Map<string, ExecutionRecord>();

  async createExecution(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const execution = buildExecutionRecord(input);
    this.executions.set(execution.id, execution);
    return execution;
  }

  async findExecution(id: string): Promise<ExecutionRecord> {
    const execution = this.executions.get(id);
    if (!execution) {
      throw new ExecutionNotFoundError(id);
    }
    return execution;
  }

  async findLatestByRunId(runId: string): Promise<ExecutionRecord | undefined> {
    const matches = (await this.listExecutions({ runId })).filter(
      (execution) => execution.runId === runId,
    );
    return matches[matches.length - 1];
  }

  async listExecutions(filter: ExecutionListFilter = {}): Promise<ExecutionRecord[]> {
    return [...this.executions.values()]
      .filter(
        (execution) =>
          (filter.runId === undefined || execution.runId === filter.runId) &&
          (filter.statuses === undefined ||
            filter.statuses.length === 0 ||
            filter.statuses.includes(execution.status)),
      )
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }

  async updateExecution(
    id: string,
    update: UpdateExecutionInput,
  ): Promise<ExecutionRecord> {
    const current = await this.findExecution(id);
    const updated: ExecutionRecord = {
      ...current,
      status: update.status ?? current.status,
      containerId: update.containerId ?? current.containerId,
      error: update.error ?? current.error,
      startedAt: update.startedAt ?? current.startedAt,
      finishedAt: update.finishedAt ?? current.finishedAt,
      cleanedAt: update.cleanedAt ?? current.cleanedAt,
      mounts: update.mounts ?? current.mounts,
    };
    this.executions.set(id, updated);
    return updated;
  }
}
