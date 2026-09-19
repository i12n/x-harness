import type { Run } from "../../domain/run.js";
import type { Task } from "../../domain/task.js";
import type { RunStore } from "../../store/runStore.js";
import type { TaskStore } from "../../store/taskStore.js";
import type { ExecuteRunOutcome, Worker } from "../../worker/worker.js";

export interface TaskRunServiceDeps {
  tasks: TaskStore;
  runs: RunStore;
  worker: Worker;
}

export interface TaskRunOutcome {
  runId: string;
  run: Run;
  outcome: ExecuteRunOutcome;
}

/**
 * TASK-1108: Task/Run operations reuse the existing Worker — the command layer
 * never re-implements execution. In a Loop-based deployment the same service
 * can instead enqueue the Run and let the Scheduler pick it up.
 */
export class TaskRunService {
  constructor(private readonly deps: TaskRunServiceDeps) {}

  async show(taskId: string): Promise<Task> {
    return this.deps.tasks.findTask(taskId);
  }

  async latestRun(taskId: string): Promise<Run | undefined> {
    const runs = await this.deps.runs.listRuns({ taskId });
    return runs[runs.length - 1];
  }

  async run(taskId: string): Promise<TaskRunOutcome> {
    const task = await this.deps.tasks.findTask(taskId);
    const existing = await this.deps.runs.listRuns({ taskId: task.id });
    const run = await this.deps.runs.createRun({
      taskId: task.id,
      attempt: existing.length + 1,
      agent: "codex",
      engine: "codex",
    });
    const outcome = await this.deps.worker.executeRun(run.id);
    return { runId: run.id, run: outcome.run, outcome };
  }
}
