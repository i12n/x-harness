import { existsSync } from "node:fs";
import type { Run } from "../domain/run.js";
import { isTerminalRunStatus } from "../domain/run.js";
import type { TaskStatus } from "../domain/task.js";
import type { ExecutionManager } from "../execution/manager.js";
import type { ExecutionMount } from "../execution/mounts.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { ExecutionStore } from "../store/executionStore.js";
import type { RepositoryStore } from "../store/repositoryStore.js";
import type { RunStore } from "../store/runStore.js";
import type { TaskStore } from "../store/taskStore.js";
import type { EventStore } from "../store/eventStore.js";
import { extractWorkspacesInfo } from "../workspace/info.js";
import type { WorkspaceManager } from "../workspace/manager.js";
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
  repositories?: RepositoryStore;
  workspaceManager?: WorkspaceManager;
  /**
   * TASK-1206: delivery reconciliation. Optional so existing deployments (and
   * tests) keep the pre-1206 tick; the port keeps Loop free of delivery
   * internals — aggregation stays in DeliveryService.
   */
  deliveryReconciler?: DeliveryReconcilerPort;
}

export interface DeliveryReconcileReportLike {
  transitions: { delivery: { id: string }; previousStatus: string; status: string }[];
  notified: number;
  notificationFailures: { deliveryId: string; status: string; reason: string }[];
  pendingNotifications: number;
  droppedNotifications: number;
}

export interface DeliveryReconcilerPort {
  reconcileAll(): Promise<DeliveryReconcileReportLike>;
}

/** TASK-1207 Phase B: which part of the tick failed. */
export type LoopPhase =
  | "recover"
  | "cancel"
  | "cleanup"
  | "delivery_reconcile"
  | "schedule";

/**
 * TASK-1207 Phase B: a phase failure is recorded and the tick continues — it is
 * never silently swallowed (message + type + optional subject are kept).
 */
export interface LoopError {
  phase: LoopPhase;
  message: string;
  errorType?: string;
  subjectId?: string;
}

export interface TickReport {
  recovered: Run[];
  cancelled: Run[];
  /** TASK-1206: delivery transitions observed during this tick. */
  deliveryTransitions: DeliveryReconcileReportLike["transitions"];
  deliveryNotifications: number;
  deliveryNotificationFailures: DeliveryReconcileReportLike["notificationFailures"];
  /** TASK-1207 Phase B: notifications still queued for a later tick. */
  deliveryPendingNotifications: number;
  scheduled: Run[];
  executed: Run[];
  cleanupRetries: number;
  /** TASK-1207 Phase B: isolated phase failures (empty in the happy path). */
  errors: LoopError[];
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
  private readonly repositories: RepositoryStore | undefined;
  private readonly workspaceManager: WorkspaceManager | undefined;
  private readonly deliveryReconciler: DeliveryReconcilerPort | undefined;

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
    this.repositories = options.repositories;
    this.workspaceManager = options.workspaceManager;
    this.deliveryReconciler = options.deliveryReconciler;
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
    const errors: LoopError[] = [];
    // TASK-1207 Phase B: every phase is isolated. A failure is recorded in
    // `errors` and the tick continues with the remaining phases.
    const recovered = await this.runPhase(
      "recover",
      errors,
      () => this.recoverExpiredRuns(),
      [] as Run[],
    );
    const cancelled = await this.runPhase(
      "cancel",
      errors,
      () => this.reconcileCancelRequests(),
      [] as Run[],
    );
    const cleanupRetries = await this.runPhase(
      "cleanup",
      errors,
      () => this.retryFailedCleanups(),
      0,
    );
    // Reconcile after Task state changed (recovery/cancel above) and before
    // scheduling picks up new work…
    let deliveries = await this.reconcileDeliveries(errors);
    const scheduled = await this.runPhase(
      "schedule",
      errors,
      () => this.scheduler.schedule(),
      [] as Run[],
    );
    const executed = await this.executeQueued();
    // …and again after execution: a Run that just finished can make a Task
    // DONE within the same tick, and the Delivery should reflect it.
    const afterExecution = await this.reconcileDeliveries(errors);
    deliveries = mergeDeliveryReports(deliveries, afterExecution);
    return {
      recovered,
      cancelled,
      deliveryTransitions: deliveries.transitions,
      deliveryNotifications: deliveries.notified,
      deliveryNotificationFailures: deliveries.notificationFailures,
      deliveryPendingNotifications: deliveries.pendingNotifications,
      scheduled,
      executed,
      cleanupRetries,
      errors,
    };
  }

  /**
   * Runs one phase, converting a failure into a `LoopError`. `subjectId` is
   * taken from the error itself when it carries `runId`/`taskId`/`deliveryId`.
   */
  private async runPhase<T>(
    phase: LoopPhase,
    errors: LoopError[],
    run: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      errors.push(toLoopError(phase, error));
      return fallback;
    }
  }

  private async reconcileDeliveries(
    errors: LoopError[],
  ): Promise<DeliveryReconcileReportLike> {
    if (!this.deliveryReconciler) {
      return {
        transitions: [],
        notified: 0,
        notificationFailures: [],
        pendingNotifications: 0,
        droppedNotifications: 0,
      };
    }
    try {
      return await this.deliveryReconciler.reconcileAll();
    } catch (error) {
      errors.push(toLoopError("delivery_reconcile", error));
      return {
        transitions: [],
        notified: 0,
        notificationFailures: [],
        pendingNotifications: 0,
        droppedNotifications: 0,
      };
    }
  }

  /**
   * TASK-1108: consume persisted cancel requests (possibly written by another
   * process). QUEUED runs finish immediately; active runs get their execution
   * and workspaces reclaimed before the Run becomes CANCELLED.
   */
  private async reconcileCancelRequests(): Promise<Run[]> {
    const pending = await this.runStore.listRuns({ cancelRequested: true });
    const cancelled: Run[] = [];
    for (const run of pending) {
      if (isTerminalRunStatus(run.status)) {
        continue;
      }
      if (run.status === "QUEUED") {
        const terminal = await this.runStore.completeRun(run.id, {
          status: "CANCELLED",
          result: { reason: "cancel requested before start" },
          finishedAt: new Date().toISOString(),
        });
        await this.releaseTask(terminal);
        await this.emit("run.cancelled", terminal, {
          reason: "cancel requested before start",
        });
        cancelled.push(terminal);
        continue;
      }
      const record = await this.reclaimExecution(
        run.id,
        "CANCELLED",
        "cancel requested",
      );
      await this.recoverWorkspaces(run, record?.mounts);
      const terminal = await this.runStore.completeRun(run.id, {
        status: "CANCELLED",
        result: { reason: "cancel requested" },
        finishedAt: new Date().toISOString(),
      });
      await this.releaseTask(terminal);
      await this.emit("run.cancelled", terminal, { reason: "cancel requested" });
      cancelled.push(terminal);
    }
    return cancelled;
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
      await this.releaseTask(lost, task);
      recovered.push(lost);
      const record = await this.reclaimExecution(run.id, "LOST", "lease expired");
      await this.recoverWorkspaces(lost, record?.mounts);
    }
    return recovered;
  }

  /** Terminal run → release the task (retry while attempts remain). */
  private async releaseTask(run: Run, knownTask?: Awaited<ReturnType<TaskStore["findTask"]>>): Promise<void> {
    const task = knownTask ?? (await this.taskStore.findTask(run.taskId));
    const nextStatus: TaskStatus = run.attempt >= task.maxAttempts ? "BLOCKED" : "READY";
    await this.taskStore.updateTaskStatus(task.id, nextStatus);
  }

  private async emit(
    type: string,
    run: Run,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.events) {
      return;
    }
    try {
      await this.events.record({
        type,
        taskId: run.taskId,
        runId: run.id,
        payload,
      });
    } catch {
      // History must never break recovery.
    }
  }

  /**
   * Worker crash recovery: the lease expiry makes the Run LOST, and the
   * persisted execution record makes the container/worktree reclaimable.
   */
  private async reclaimExecution(
    runId: string,
    status: "LOST" | "CANCELLED",
    reason: string,
  ): Promise<
    Awaited<ReturnType<ExecutionStore["findLatestByRunId"]>>
  > {
    if (!this.executions || !this.executionManager) {
      return undefined;
    }
    const record = await this.executions.findLatestByRunId(runId);
    if (!record || record.status === "CLEANED") {
      return record;
    }
    await this.executionManager.finish(record, status, reason);
    await this.executionManager.cleanupRecord(record);
    return record;
  }

  /**
   * TASK-1010: a lost run must release every target workspace, not just the
   * primary one. Paths come from the persisted run evidence; missing paths are
   * treated as already reclaimed.
   */
  private async recoverWorkspaces(
    run: Run,
    mounts?: ExecutionMount[],
  ): Promise<void> {
    if (!this.repositories || !this.workspaceManager) {
      return;
    }
    // A crashed worker may not have written run.result yet: the execution
    // record's mounts are the authoritative evidence of its workspaces.
    const evidence = new Map<string, { targetId?: string; path: string; branch: string }>();
    for (const mount of mounts ?? []) {
      evidence.set(mount.source, {
        targetId: mount.targetId,
        path: mount.source,
        branch: "",
      });
    }
    for (const workspace of extractWorkspacesInfo(run)) {
      evidence.set(workspace.path, workspace);
    }
    if (evidence.size === 0) {
      return;
    }
    const task = await this.taskStore.findTask(run.taskId);
    const targetById = new Map(task.targets.map((target) => [target.id, target]));
    const removed: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const workspace of evidence.values()) {
      if (!existsSync(workspace.path)) {
        removed.push(workspace.path);
        continue;
      }
      try {
        const repositoryId =
          (workspace.targetId
            ? targetById.get(workspace.targetId)?.repositoryId
            : undefined) ?? task.repositoryId;
        const repository = await this.repositories.findRepository(repositoryId);
        await this.workspaceManager.removeWorkspace({
          path: workspace.path,
          repositoryLocalPath: repository.localPath,
        });
        removed.push(workspace.path);
      } catch (error) {
        skipped.push({
          path: workspace.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.events) {
      try {
        await this.events.record({
          type: "workspaces.cleaned",
          taskId: run.taskId,
          runId: run.id,
          payload: { reason: "run lost", removed, skipped },
        });
      } catch {
        // History must never break recovery.
      }
    }
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

/** TASK-1207 Phase B: keep enough context to act on a phase failure. */
function toLoopError(phase: LoopPhase, error: unknown): LoopError {
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const subjectId = ["runId", "taskId", "deliveryId"]
    .map((key) => record?.[key])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return {
    phase,
    message: error instanceof Error ? error.message : String(error),
    errorType: error instanceof Error ? error.name : undefined,
    subjectId,
  };
}

/** Two delivery passes run per tick; the report merges both (by delivery id). */
function mergeDeliveryReports(
  first: DeliveryReconcileReportLike,
  second: DeliveryReconcileReportLike,
): DeliveryReconcileReportLike {
  const transitions = new Map<string, DeliveryReconcileReportLike["transitions"][number]>();
  for (const transition of [...first.transitions, ...second.transitions]) {
    transitions.set(transition.delivery.id, transition);
  }
  return {
    transitions: [...transitions.values()],
    notified: first.notified + second.notified,
    notificationFailures: [
      ...first.notificationFailures,
      ...second.notificationFailures,
    ],
    pendingNotifications: second.pendingNotifications,
    droppedNotifications: first.droppedNotifications + second.droppedNotifications,
  };
}
