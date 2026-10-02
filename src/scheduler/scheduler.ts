import { ACTIVE_RUN_STATUSES } from "../domain/run.js";
import type { Run } from "../domain/run.js";
import type { Task } from "../domain/task.js";
import { DuplicateActiveRunError } from "../errors.js";
import type { RunStore } from "../store/runStore.js";
import type { TaskStore } from "../store/taskStore.js";
import type { EventStore } from "../store/eventStore.js";

/**
 * Narrow port for the dependency-aware selection (TASK-1204).
 * `TaskDependencyService` satisfies it; the Scheduler never queries
 * `task_dependencies` and never walks the graph itself.
 */
export interface RunnableTaskQuery {
  listRunnableTasks(): Promise<Task[]>;
}

export interface SchedulerOptions {
  taskStore: TaskStore;
  runStore: RunStore;
  maxConcurrency?: number;
  agent?: string;
  engine?: string;
  eventStore?: EventStore;
  /**
   * Dependency gate. Without it every READY task is a candidate (the
   * pre-TASK-1204 behavior, kept for compatibility); with it, a READY task
   * whose prerequisites are not DONE is simply not selected.
   */
  runnableTasks?: RunnableTaskQuery;
  /** TASK-1215: refuses to hand out work once the day's budget is spent. */
  budget?: { canStart(): Promise<boolean> };
}

/**
 * Scheduler (plan section 十/十一): find READY tasks -> check worker capacity
 * -> create QUEUED runs. A task with an active run is never scheduled twice.
 *
 * TASK-1204: selection additionally requires the task to be runnable
 * (all dependencies DONE). Dependencies never consume a concurrency slot —
 * only the Runs that are actually created do.
 */
export class Scheduler {
  private readonly taskStore: TaskStore;
  private readonly runStore: RunStore;
  private readonly maxConcurrency: number;
  private readonly agent: string;
  private readonly engine: string;
  private readonly events: EventStore | undefined;
  private readonly runnableTasks: RunnableTaskQuery | undefined;
  private readonly budget: { canStart(): Promise<boolean> } | undefined;

  constructor(options: SchedulerOptions) {
    this.taskStore = options.taskStore;
    this.runStore = options.runStore;
    this.maxConcurrency =
      options.maxConcurrency ??
      Number(process.env.AI_MAX_CONCURRENCY ?? 2);
    this.agent = options.agent ?? "codex";
    this.engine = options.engine ?? "codex";
    this.events = options.eventStore;
    this.runnableTasks = options.runnableTasks;
    this.budget = options.budget;
  }

  async schedule(): Promise<Run[]> {
    // TASK-1215: no new work while the day's token budget is gone.
    if (this.budget && !(await this.budget.canStart())) {
      return [];
    }
    const ready: Task[] = (await this.taskStore.listTasks({ status: "READY" })).sort(
      (a, b) =>
        b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
    );
    const runnableIds = this.runnableTasks
      ? new Set((await this.runnableTasks.listRunnableTasks()).map((task) => task.id))
      : undefined;
    const activeRuns = await this.runStore.listRuns({
      statuses: [...ACTIVE_RUN_STATUSES],
    });
    const busyTaskIds = new Set(activeRuns.map((run) => run.taskId));
    const capacity = Math.max(0, this.maxConcurrency - activeRuns.length);

    const created: Run[] = [];
    for (const task of ready) {
      if (busyTaskIds.has(task.id) || created.length >= capacity) {
        continue;
      }
      if (runnableIds && !runnableIds.has(task.id)) {
        continue;
      }
      const previousRuns = await this.runStore.listRuns({ taskId: task.id });
      let run: Run;
      try {
        run = await this.runStore.createRun({
          taskId: task.id,
          attempt: previousRuns.length + 1,
          agent: this.agent,
          engine: this.engine,
        });
      } catch (error) {
        if (error instanceof DuplicateActiveRunError) {
          // Another scheduler (or process) won the race for this task.
          continue;
        }
        throw error;
      }
      created.push(run);
      if (this.events) {
        try {
          await this.events.record({
            type: "RunCreated",
            taskId: task.id,
            runId: run.id,
            payload: { attempt: run.attempt },
          });
        } catch {
          // History must never break scheduling.
        }
      }
    }
    return created;
  }
}
