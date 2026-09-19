import type {
  AddTaskDependencyInput,
  TaskDependency,
} from "../domain/taskDependency.js";

/**
 * Persistence contract for `task_dependencies` (Phase 12 / TASK-1203).
 * DAG validation (self/duplicate/cycle) lives in TaskDependencyService; the
 * store only enforces the storage constraints (PK, CHECK, FKs).
 */
export interface TaskDependencyStore {
  addDependency(input: AddTaskDependencyInput): Promise<TaskDependency>;
  findDependency(
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<TaskDependency | undefined>;
  /** Prerequisites of one task (its incoming edges). */
  listDependencies(taskId: string): Promise<TaskDependency[]>;
  /** Tasks waiting on one task (its outgoing edges). */
  listDependents(dependsOnTaskId: string): Promise<TaskDependency[]>;
  /** Every edge, used for whole-graph cycle detection. */
  listAllDependencies(): Promise<TaskDependency[]>;
}
