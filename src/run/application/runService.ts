import { isTerminalRunStatus } from "../../domain/run.js";
import type { Run } from "../../domain/run.js";
import { RunNotCancellableError } from "../../errors.js";
import type { EventStore } from "../../store/eventStore.js";
import type { RunStore } from "../../store/runStore.js";
import type { TaskStore } from "../../store/taskStore.js";

export interface RunCancelActor {
  channel: string;
  userId: string;
}

export interface RunCancelOutcome {
  run: Run;
  /** "cancelled" = finished synchronously (QUEUED); "accepted" = requested. */
  status: "accepted" | "cancelled";
  alreadyRequested: boolean;
}

export interface RunServiceDeps {
  runs: RunStore;
  tasks: TaskStore;
  events?: EventStore;
}

/**
 * TASK-1108: Run application service. Cancellation is a persisted *control
 * intent*: QUEUED runs finish immediately, active runs record a request that a
 * Worker/Loop consumes. Run.status keeps describing facts only.
 */
export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  async show(runId: string): Promise<Run> {
    return this.deps.runs.findRun(runId);
  }

  async cancel(runId: string, actor: RunCancelActor): Promise<RunCancelOutcome> {
    const run = await this.deps.runs.findRun(runId);
    if (isTerminalRunStatus(run.status)) {
      throw new RunNotCancellableError(runId, run.status);
    }
    const requestedBy = `${actor.channel}:${actor.userId}`;

    if (run.status === "QUEUED") {
      const cancelled = await this.deps.runs.completeRun(runId, {
        status: "CANCELLED",
        result: { cancelledBy: requestedBy, reason: "cancelled before start" },
        finishedAt: new Date().toISOString(),
      });
      await this.recoverTask(cancelled);
      await this.emit("run.cancelled", cancelled, {
        reason: "cancelled before start",
        actor: requestedBy,
      });
      return { run: cancelled, status: "cancelled", alreadyRequested: false };
    }

    const alreadyRequested = Boolean(run.cancelRequestedAt);
    const requested = alreadyRequested
      ? run
      : await this.deps.runs.requestCancel(runId, requestedBy);
    if (!alreadyRequested) {
      await this.emit("run.cancel_requested", requested, { actor: requestedBy });
    }
    return { run: requested, status: "accepted", alreadyRequested };
  }

  /** Consumed by Loop/Worker after the run reaches a terminal state. */
  async recoverTask(run: Run): Promise<void> {
    const task = await this.deps.tasks.findTask(run.taskId);
    const attempts = (await this.deps.runs.listRuns({ taskId: run.taskId })).length;
    const next = attempts >= task.maxAttempts ? "BLOCKED" : "READY";
    await this.deps.tasks.updateTaskStatus(task.id, next);
  }

  private async emit(
    type: string,
    run: Run,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    try {
      await this.deps.events.record({
        type,
        taskId: run.taskId,
        runId: run.id,
        payload,
      });
    } catch {
      // History must never break cancellation.
    }
  }
}
