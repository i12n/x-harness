import type { Run } from "../domain/run.js";
import type { TaskStatus } from "../domain/task.js";
import type { ExecutionManager } from "../execution/manager.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { ExecutionStore } from "../store/executionStore.js";
import type { RunStore } from "../store/runStore.js";
import type { TaskStore } from "../store/taskStore.js";
import type { EventStore } from "../store/eventStore.js";
import type { Worker } from "../worker/worker.js";

export interface LoopOptions {
  scheduler: Scheduler;
  worker: Worker;
  runStore: RunStore;
  taskStore: TaskStore;
  maxConcurrency?: number;
  eventStore?: EventStore;
  executions?: ExecutionStore;
  executionManager?: ExecutionManager;
}

export interface TickReport {
  recovered: Run[];
  scheduled: Run[];
  executed: Run[];
  cleanupRetries: number;
}

/**
 * Loop (plan section 二十/二十一): Observe -> Reconcile -> Schedule -> Execute
 * -> Recover. Runs forever when started; tick() runs one reconciliation pass.
 */
export class Loop {
  private readonly scheduler: Scheduler;
  private readonly worker: Worker;
  private readonly runStore: RunStore;
  private readonly taskStore: TaskStore;
  private readonly maxConcurrency: number;
  private running = false;
  private readonly events: EventStore | undefined;
  private readonly executions: ExecutionStore | undefined;
  private readonly executionManager: ExecutionManager | undefined;

  constructor(options: LoopOptions) {
    this.scheduler = options.scheduler;
    this.worker = options.worker;
    this.runStore = options.runStore;
    this.taskStore = options.taskStore;
    this.maxConcurrency =
      options.maxConcurrency ??
      Number(process.env.AI_MAX_CONCURRENCY ?? 2);
    this.events = options.eventStore;
    this.executions = options.executions;
    this.executionManager = options.executionManager;
  }

  async start(intervalMs = 1_000): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    while (this.running) {
      await this.tick();
      await sleep(intervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  async tick(): Promise<TickReport> {
    const recovered = await this.recoverExpiredRuns();
    const cleanupRetries = await this.retryFailedCleanups();
    const scheduled = await this.scheduler.schedule();
    const executed = await this.executeQueued();
    return { recovered, scheduled, executed, cleanupRetries };
  }

  /** Recover runs whose lease expired: mark LOST and release the task. */
  private async recoverExpiredRuns(): Promise<Run[]> {
    const candidates = await this.runStore.listRuns({
      statuses: ["STARTING", "RUNNING", "VERIFYING"],
    });
    const recovered: Run[] = [];
    const now = Date.now();
    for (const run of candidates) {
      if (!run.leaseUntil || new Date(run.leaseUntil).getTime() > now) {
        continue;
      }
      const lost = await this.runStore.updateRunStatus(run.id, "LOST");
      if (this.events) {
        try {
          await this.events.record({
            type: "RunLost",
            taskId: run.taskId,
            runId: run.id,
            payload: { reason: "lease expired" },
          });
        } catch {
          // History must never break recovery.
        }
      }
      const task = await this.taskStore.findTask(run.taskId);
      const nextStatus: TaskStatus = run.attempt >= task.maxAttempts ? "BLOCKED" : "READY";
      await this.taskStore.updateTaskStatus(task.id, nextStatus);
      recovered.push(lost);
      await this.recoverExecution(run.id);
    }
    return recovered;
  }

  /**
   * Worker crash recovery: the lease expiry makes the Run LOST, and the
   * persisted execution record makes the container/worktree reclaimable.
   */
  private async recoverExecution(runId: string): Promise<void> {
    if (!this.executions || !this.executionManager) {
      return;
    }
    const record = await this.executions.findLatestByRunId(runId);
    if (!record || record.status === "CLEANED") {
      return;
    }
    await this.executionManager.finish(record, "LOST", "lease expired");
    await this.executionManager.cleanupRecord(record);
  }

  /** Cleanup failures are recoverable: retry them on every tick. */
  private async retryFailedCleanups(): Promise<number> {
    if (!this.executions || !this.executionManager) {
      return 0;
    }
    const failed = await this.executions.listExecutions({
      statuses: ["CLEANUP_FAILED"],
    });
    for (const record of failed) {
      await this.executionManager.cleanupRecord(record);
    }
    return failed.length;
  }

  private async executeQueued(): Promise<Run[]> {
    const queued = await this.runStore.listRuns({ statuses: ["QUEUED"] });
    if (queued.length === 0) {
      return [];
    }

    const executed: Run[] = [];
    let nextIndex = 0;
    let active = 0;
    await new Promise<void>((resolve) => {
      const pump = (): void => {
        while (active < this.maxConcurrency && nextIndex < queued.length) {
          const runId = queued[nextIndex]?.id;
          nextIndex += 1;
          if (!runId) {
            continue;
          }
          active += 1;
          this.worker
            .executeRun(runId)
            .then((outcome) => {
              executed.push(outcome.run);
            })
            .catch(() => {
              // Failures are already persisted (run FAILED, task READY/BLOCKED);
              // the next tick retries whatever is READY again.
            })
            .finally(() => {
              active -= 1;
              pump();
            });
        }
        if (active === 0) {
          resolve();
        }
      };
      pump();
    });
    return executed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
