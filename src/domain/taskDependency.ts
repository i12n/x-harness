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

/**
 * TASK-1207: a Task whose ancestor ended in one of these statuses can never
 * become runnable without human action (BLOCKED is the system's terminal
 * failure state, FAILED is the externally/internally set equivalent).
 */
export const DEPENDENCY_FAILURE_STATUSES: TaskStatus[] = ["FAILED", "BLOCKED"];

/** Minimal, store-free view of the DAG needed for impact computation. */
export interface TaskDependencySnapshot {
  tasks: { id: string; status: TaskStatus }[];
  dependencies: { taskId: string; dependsOnTaskId: string }[];
}

/**
 * TASK-1207: computed reachability facts for one Task.
 * `dependencyBlocked` is a *fact*, never a Task status transition.
 */
export interface TaskDependencyImpact {
  runnable: boolean;
  waiting: boolean;
  dependencyBlocked: boolean;
  /** Failed ancestors (FAILED/BLOCKED), transitive, deterministic order. */
  blockingTaskIds: string[];
  /** Shortest chain failedAncestor → … → taskId (empty when not blocked). */
  blockingChain: string[];
  /** Edges pointing at Tasks that do not exist (never happens under PG FKs). */
  missingTaskIds: string[];
}

/**
 * Pure impact computation: no store access, no Task mutation, no Run creation,
 * no Delivery/Notification side effects.
 *
 *   Runnable            READY + every direct prerequisite DONE
 *   Waiting             READY + an unfinished prerequisite + no failure chain
 *   Dependency-Blocked  READY + a FAILED/BLOCKED ancestor (or a dangling edge)
 */
export function getTaskDependencyImpact(
  taskId: string,
  snapshot: TaskDependencySnapshot,
): TaskDependencyImpact {
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const dependsOn = new Map<string, string[]>();
  for (const dependency of snapshot.dependencies) {
    const prerequisites = dependsOn.get(dependency.taskId);
    if (prerequisites) {
      if (!prerequisites.includes(dependency.dependsOnTaskId)) {
        prerequisites.push(dependency.dependsOnTaskId);
      }
    } else {
      dependsOn.set(dependency.taskId, [dependency.dependsOnTaskId]);
    }
  }
  for (const prerequisites of dependsOn.values()) {
    prerequisites.sort();
  }

  const task = tasksById.get(taskId);
  if (!task) {
    return {
      runnable: false,
      waiting: false,
      dependencyBlocked: false,
      blockingTaskIds: [],
      blockingChain: [],
      missingTaskIds: [taskId],
    };
  }

  // Breadth-first walk over prerequisites; `parent` records the shortest path
  // back towards the task so the blocking chain is deterministic.
  const parent = new Map<string, string>();
  const seen = new Set<string>([taskId]);
  const queue: string[] = [taskId];
  const missingTaskIds: string[] = [];
  const ancestors: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const prerequisiteId of dependsOn.get(current) ?? []) {
      if (!tasksById.has(prerequisiteId) && !missingTaskIds.includes(prerequisiteId)) {
        missingTaskIds.push(prerequisiteId);
      }
      if (seen.has(prerequisiteId)) {
        continue;
      }
      seen.add(prerequisiteId);
      parent.set(prerequisiteId, current);
      ancestors.push(prerequisiteId);
      queue.push(prerequisiteId);
    }
  }

  const failedAncestors = ancestors
    .filter((id) => {
      const status = tasksById.get(id)?.status;
      return status !== undefined && DEPENDENCY_FAILURE_STATUSES.includes(status);
    })
    .sort();

  const directIds = dependsOn.get(taskId) ?? [];
  const knownPrerequisites = directIds
    .map((id) => tasksById.get(id))
    .filter((entry): entry is { id: string; status: TaskStatus } => entry !== undefined);
  const allPrerequisitesKnown = knownPrerequisites.length === directIds.length;
  const runnable =
    task.status === "READY" &&
    allPrerequisitesKnown &&
    isTaskRunnable(task, knownPrerequisites);
  const dependencyBlocked =
    task.status === "READY" &&
    !runnable &&
    (failedAncestors.length > 0 || !allPrerequisitesKnown);
  const waiting = task.status === "READY" && !runnable && !dependencyBlocked;

  return {
    runnable,
    waiting,
    dependencyBlocked,
    blockingTaskIds: dependencyBlocked ? failedAncestors : [],
    blockingChain:
      dependencyBlocked && failedAncestors.length > 0
        ? blockingChainFor(taskId, failedAncestors[0]!, parent)
        : [],
    missingTaskIds,
  };
}

function blockingChainFor(
  taskId: string,
  failedAncestor: string,
  parent: Map<string, string>,
): string[] {
  const chain = [failedAncestor];
  const guard = new Set<string>([failedAncestor]);
  let cursor = failedAncestor;
  while (cursor !== taskId) {
    const next = parent.get(cursor);
    if (!next || guard.has(next)) {
      break;
    }
    guard.add(next);
    chain.push(next);
    cursor = next;
  }
  if (chain[chain.length - 1] !== taskId) {
    chain.push(taskId);
  }
  return chain;
}
