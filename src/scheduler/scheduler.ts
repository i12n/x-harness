import { ACTIVE_RUN_STATUSES } from "../domain/run.js";
import type { Run } from "../domain/run.js";
import type { Task } from "../domain/task.js";
import type { RunStore } from "../store/runStore.js";
import type { TaskStore } from "../store/taskStore.js";
import type { EventStore } from "../store/eventStore.js";

export interface SchedulerOptions {
  taskStore: TaskStore;
  runStore: RunStore;
  maxConcurrency?: number;
  agent?: string;
  engine?: string;
  eventStore?: EventStore;
}

/**
 * Scheduler (plan section 十/十一): find READY tasks -> check worker capacity
 * -> create QUEUED runs. A task with an active run is never scheduled twice.
 */
export class Scheduler {
  private readonly taskStore: TaskStore;
  private readonly runStore: RunStore;
  private readonly maxConcurrency: number;
  private readonly agent: string;
  private readonly engine: string;
  private readonly events: EventStore | undefined;

  constructor(options: SchedulerOptions) {
    this.taskStore = options.taskStore;
    this.runStore = options.runStore;
    this.maxConcurrency =
      options.maxConcurrency ??
      Number(process.env.AI_MAX_CONCURRENCY ?? 2);
    this.agent = options.agent ?? "codex";
    this.engine = options.engine ?? "codex";
    this.events = options.eventStore;
  }

  async schedule(): Promise<Run[]> {
    const ready: Task[] = (await this.taskStore.listTasks({ status: "READY" })).sort(
      (a, b) =>
        b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
    );
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
      const previousRuns = await this.runStore.listRuns({ taskId: task.id });
      const run = await this.runStore.createRun({
        taskId: task.id,
        attempt: previousRuns.length + 1,
        agent: this.agent,
        engine: this.engine,
      });
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
