import type { Run } from "../../domain/run.js";
import type { Task } from "../../domain/task.js";
import type { RunStore } from "../../store/runStore.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { TaskStore } from "../../store/taskStore.js";
import type { TaskDependencyView } from "../../task/application/dependencyService.js";
import type { ExecuteRunOutcome, Worker } from "../../worker/worker.js";

/** Only the read side of TaskDependencyService is needed here. */
export interface TaskDependencyReadSource {
  describe(taskId: string): Promise<TaskDependencyView>;
  isRunnable(taskId: string): Promise<boolean>;
}

export interface TaskRunServiceDeps {
  tasks: TaskStore;
  runs: RunStore;
  worker: Worker;
  repositories?: RepositoryStore;
  /** Optional: adds the dependency/runnable view to task descriptions. */
  dependencies?: TaskDependencyReadSource;
}

export interface TaskRunOutcome {
  runId: string;
  run: Run;
  outcome: ExecuteRunOutcome;
}

export interface TaskDescription {
  task: Task;
  latestRun?: Run;
  /** repositoryId → display name (for renderers). */
  repositoryNames: Map<string, string>;
  /** Prerequisites + runnable flag (TASK-1204 visibility). */
  dependency?: TaskDependencyView;
  runnable?: boolean;
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

  /** Task + latest run + repository names (renderer-friendly). */
  async describeTask(taskId: string): Promise<TaskDescription> {
    const task = await this.show(taskId);
    const repositoryNames = new Map<string, string>();
    if (this.deps.repositories) {
      for (const target of task.targets) {
        if (repositoryNames.has(target.repositoryId)) {
          continue;
        }
        try {
          const repository = await this.deps.repositories.findRepository(
            target.repositoryId,
          );
          repositoryNames.set(repository.id, repository.name);
        } catch {
          repositoryNames.set(target.repositoryId, target.repositoryId);
        }
      }
    }
    const dependency = this.deps.dependencies
      ? await this.deps.dependencies.describe(taskId)
      : undefined;
    const runnable = this.deps.dependencies
      ? await this.deps.dependencies.isRunnable(taskId)
      : undefined;
    return {
      task,
      latestRun: await this.latestRun(task.id),
      repositoryNames,
      dependency,
      runnable,
    };
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
