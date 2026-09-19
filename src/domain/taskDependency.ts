import type { Task, TaskStatus } from "./task.js";
import { ValidationError } from "../errors.js";

/**
 * One DAG edge (Phase 12 / TASK-1203): `taskId` must wait for
 * `dependsOnTaskId` to be DONE. Edges live on the Task layer and may cross
 * Specifications.
 */
export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}

export interface AddTaskDependencyInput {
  taskId: string;
  dependsOnTaskId: string;
}

export function buildTaskDependency(
  input: AddTaskDependencyInput,
): TaskDependency {
  const taskId = input.taskId?.trim();
  const dependsOnTaskId = input.dependsOnTaskId?.trim();
  if (!taskId || !dependsOnTaskId) {
    throw new ValidationError("task dependency requires both task ids");
  }
  if (taskId === dependsOnTaskId) {
    throw new ValidationError(`task ${taskId} cannot depend on itself`);
  }
  return {
    taskId,
    dependsOnTaskId,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Would adding `taskId depends on dependsOnTaskId` close a cycle?
 * Walks the "depends on" edges forward from `dependsOnTaskId` looking for
 * `taskId` (i.e. does the prerequisite already wait, directly or
 * transitively, on the task we are about to gate?).
 */
export function createsDependencyCycle(
  dependencies: Pick<TaskDependency, "taskId" | "dependsOnTaskId">[],
  taskId: string,
  dependsOnTaskId: string,
): boolean {
  const graph = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const edges = graph.get(dependency.taskId);
    if (edges) {
      edges.push(dependency.dependsOnTaskId);
    } else {
      graph.set(dependency.taskId, [dependency.dependsOnTaskId]);
    }
  }

  const stack = [dependsOnTaskId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of graph.get(current) ?? []) {
      stack.push(next);
    }
  }
  return false;
}

/**
 * A Task is runnable when it is READY and every prerequisite is DONE.
 * Only DONE satisfies a dependency: REVIEW/FAILED/BLOCKED/RUNNING do not.
 */
export function isTaskRunnable(
  task: Pick<Task, "status">,
  prerequisites: Pick<Task, "status">[],
): boolean {
  if (task.status !== "READY") {
    return false;
  }
  return prerequisites.every(
    (prerequisite) => prerequisite.status === DEPENDENCY_SATISFIED_STATUS,
  );
}

/** The only Task status that satisfies a dependency. */
export const DEPENDENCY_SATISFIED_STATUS: TaskStatus = "DONE";

/** Statuses that are recorded but deliberately do not satisfy a dependency. */
export const UNMET_DEPENDENCY_STATUSES: TaskStatus[] = [
  "INBOX",
  "READY",
  "RUNNING",
  "VERIFYING",
  "REVIEW",
  "BLOCKED",
  "FAILED",
];
