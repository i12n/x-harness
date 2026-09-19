import type { Task } from "../../domain/task.js";
import {
  createsDependencyCycle,
  getTaskDependencyImpact,
  isTaskRunnable,
} from "../../domain/taskDependency.js";
import type {
  TaskDependency,
  TaskDependencyImpact,
} from "../../domain/taskDependency.js";
import {
  DuplicateTaskDependencyError,
  HarnessError,
  TaskNotFoundError,
} from "../../errors.js";
import type { EventStore } from "../../store/eventStore.js";
import type { TaskDependencyStore } from "../../store/taskDependencyStore.js";
import type { TaskStore } from "../../store/taskStore.js";

/** Domain rejections of the dependency graph. */
export class TaskDependencyError extends HarnessError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskDependencyError";
    this.code = code;
  }
}

export interface AddDependencyOutcome {
  dependency: TaskDependency;
  /** False when the edge already existed (idempotent re-add). */
  created: boolean;
}

export interface TaskDependencyView {
  task: Task;
  dependencies: TaskDependency[];
  prerequisites: Task[];
  dependents: TaskDependency[];
  /** TASK-1207: computed reachability facts (runnable/waiting/blocked). */
  impact: TaskDependencyImpact;
}

export interface TaskDependencyServiceDeps {
  tasks: TaskStore;
  dependencies: TaskDependencyStore;
  events?: EventStore;
}

/**
 * TASK-1203: task dependency graph.
 *
 *   TaskDependencyService → domain validation → TaskDependencyStore
 *
 * The service owns graph *legality* (both tasks exist, no self edge, no
 * cycles, duplicates idempotent) and exposes the runnable predicate. It never
 * selects work for execution — the Scheduler stays a consumer of a valid
 * graph (TASK-1204 turns it into DAG-aware selection).
 */
export class TaskDependencyService {
  constructor(private readonly deps: TaskDependencyServiceDeps) {}

  /** `taskId` will wait for `dependsOnTaskId` to reach DONE. */
  async addDependency(
    taskIdInput: string,
    dependsOnTaskIdInput: string,
  ): Promise<AddDependencyOutcome> {
    const taskId = taskIdInput?.trim();
    const dependsOnTaskId = dependsOnTaskIdInput?.trim();
    if (!taskId || !dependsOnTaskId) {
      throw new TaskDependencyError(
        "invalid_dependency",
        "task dependency requires both task ids",
      );
    }
    if (taskId === dependsOnTaskId) {
      throw new TaskDependencyError(
        "task_dependency_self",
        `task ${taskId} cannot depend on itself`,
      );
    }
    await this.requireTask(taskId);
    await this.requireTask(dependsOnTaskId);

    const existing = await this.deps.dependencies.findDependency(
      taskId,
      dependsOnTaskId,
    );
    if (existing) {
      return { dependency: existing, created: false };
    }

    const graph = await this.deps.dependencies.listAllDependencies();
    if (createsDependencyCycle(graph, taskId, dependsOnTaskId)) {
      throw new TaskDependencyError(
        "task_dependency_cycle",
        `adding ${taskId} → ${dependsOnTaskId} would create a dependency cycle`,
      );
    }

    let dependency: TaskDependency;
    try {
      dependency = await this.deps.dependencies.addDependency({
        taskId,
        dependsOnTaskId,
      });
    } catch (error) {
      if (error instanceof DuplicateTaskDependencyError) {
        // Lost a race with a concurrent add: the edge is there either way.
        const raced = await this.deps.dependencies.findDependency(
          taskId,
          dependsOnTaskId,
        );
        if (raced) {
          return { dependency: raced, created: false };
        }
      }
      throw error;
    }
    await this.emit("task.dependency.added", taskId, {
      dependsOnTaskId,
    });
    return { dependency, created: true };
  }

  /** Incoming edges + the prerequisite tasks, plus the reverse edges. */
  async describe(taskId: string): Promise<TaskDependencyView> {
    const task = await this.requireTask(taskId);
    const dependencies = await this.deps.dependencies.listDependencies(taskId);
    const prerequisites: Task[] = [];
    for (const dependency of dependencies) {
      try {
        prerequisites.push(await this.deps.tasks.findTask(dependency.dependsOnTaskId));
      } catch (error) {
        if (!(error instanceof TaskNotFoundError)) {
          throw error;
        }
      }
    }
    return {
      task,
      dependencies,
      prerequisites,
      dependents: await this.deps.dependencies.listDependents(taskId),
      impact: await this.getImpact(taskId),
    };
  }

  /**
   * TASK-1207: reachability facts for one task. Loads the prerequisite closure
   * (bounded by the DAG above this task) and delegates the graph reasoning to
   * the pure domain function — no Task mutation, no Run, no notification.
   */
  async getImpact(taskId: string): Promise<TaskDependencyImpact> {
    const task = await this.requireTask(taskId);
    const edges = await this.deps.dependencies.listAllDependencies();
    const dependenciesByTask = new Map<string, string[]>();
    for (const edge of edges) {
      const list = dependenciesByTask.get(edge.taskId);
      if (list) {
        list.push(edge.dependsOnTaskId);
      } else {
        dependenciesByTask.set(edge.taskId, [edge.dependsOnTaskId]);
      }
    }

    const closure = new Map<string, { id: string; status: Task["status"] }>([
      [task.id, { id: task.id, status: task.status }],
    ]);
    const queue = [task.id];
    const reachableEdges: { taskId: string; dependsOnTaskId: string }[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const prerequisiteId of dependenciesByTask.get(current) ?? []) {
        reachableEdges.push({ taskId: current, dependsOnTaskId: prerequisiteId });
        if (closure.has(prerequisiteId)) {
          continue;
        }
        queue.push(prerequisiteId);
        try {
          const prerequisite = await this.deps.tasks.findTask(prerequisiteId);
          closure.set(prerequisiteId, {
            id: prerequisite.id,
            status: prerequisite.status,
          });
        } catch (error) {
          if (!(error instanceof TaskNotFoundError)) {
            throw error;
          }
          // Dangling edge: the pure function reports it as `missingTaskIds`.
        }
      }
    }

    return getTaskDependencyImpact(taskId, {
      tasks: [...closure.values()],
      dependencies: reachableEdges,
    });
  }

  /** READY and every prerequisite DONE. */
  async isRunnable(taskId: string): Promise<boolean> {
    const task = await this.deps.tasks.findTask(taskId);
    const prerequisites = await this.prerequisiteTasks(taskId);
    return prerequisites !== undefined && isTaskRunnable(task, prerequisites);
  }

  /**
   * Every task that can run right now: READY + all prerequisites DONE.
   * This is a query, not a selection policy — the Scheduler does not use it
   * yet (TASK-1204).
   */
  async listRunnableTasks(): Promise<Task[]> {
    const tasks = await this.deps.tasks.listTasks();
    const graph = await this.deps.dependencies.listAllDependencies();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const dependenciesByTask = new Map<string, string[]>();
    for (const edge of graph) {
      const list = dependenciesByTask.get(edge.taskId);
      if (list) {
        list.push(edge.dependsOnTaskId);
      } else {
        dependenciesByTask.set(edge.taskId, [edge.dependsOnTaskId]);
      }
    }

    return tasks.filter((task) => {
      const prerequisiteIds = dependenciesByTask.get(task.id) ?? [];
      // A missing prerequisite row can only happen outside Postgres; treat it
      // as unmet rather than runnable.
      if (prerequisiteIds.some((id) => !byId.has(id))) {
        return false;
      }
      const prerequisites = prerequisiteIds.map((id) => byId.get(id)!);
      return isTaskRunnable(task, prerequisites);
    });
  }

  /** Tasks that are waiting for `taskId` (they become runnable on DONE). */
  async listDependents(taskId: string): Promise<Task[]> {
    const edges = await this.deps.dependencies.listDependents(taskId);
    const dependents: Task[] = [];
    for (const edge of edges) {
      dependents.push(await this.deps.tasks.findTask(edge.taskId));
    }
    return dependents;
  }

  /** `undefined` means an edge points at a Task that no longer exists. */
  private async prerequisiteTasks(taskId: string): Promise<Task[] | undefined> {
    const edges = await this.deps.dependencies.listDependencies(taskId);
    const prerequisites: Task[] = [];
    for (const edge of edges) {
      try {
        prerequisites.push(await this.deps.tasks.findTask(edge.dependsOnTaskId));
      } catch (error) {
        if (error instanceof TaskNotFoundError) {
          // Unmet by definition: a dangling edge never satisfies a dependency.
          return undefined;
        }
        throw error;
      }
    }
    return prerequisites;
  }

  private async requireTask(taskId: string): Promise<Task> {
    try {
      return await this.deps.tasks.findTask(taskId);
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        throw new TaskDependencyError("task_not_found", error.message);
      }
      throw error;
    }
  }

  private async emit(
    type: string,
    taskId: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    try {
      await this.deps.events.record({ type, taskId, payload });
    } catch {
      // History must never break the dependency graph.
    }
  }
}
