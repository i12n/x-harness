import { buildTaskDependency } from "../domain/taskDependency.js";
import type {
  AddTaskDependencyInput,
  TaskDependency,
} from "../domain/taskDependency.js";
import { DuplicateTaskDependencyError } from "../errors.js";
import type { TaskDependencyStore } from "./taskDependencyStore.js";

/** Non-persistent dependency store, used by tests and memory-mode demos. */
export class InMemoryTaskDependencyStore implements TaskDependencyStore {
  private readonly edges = new Map<string, TaskDependency>();

  async addDependency(input: AddTaskDependencyInput): Promise<TaskDependency> {
    const dependency = buildTaskDependency(input);
    const key = edgeKey(dependency.taskId, dependency.dependsOnTaskId);
    const existing = this.edges.get(key);
    if (existing) {
      throw new DuplicateTaskDependencyError(
        dependency.taskId,
        dependency.dependsOnTaskId,
      );
    }
    this.edges.set(key, dependency);
    return dependency;
  }

  async findDependency(
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<TaskDependency | undefined> {
    return this.edges.get(edgeKey(taskId, dependsOnTaskId));
  }

  async listDependencies(taskId: string): Promise<TaskDependency[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.taskId === taskId)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.dependsOnTaskId.localeCompare(b.dependsOnTaskId),
      );
  }

  async listDependents(dependsOnTaskId: string): Promise<TaskDependency[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.dependsOnTaskId === dependsOnTaskId)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId),
      );
  }

  async listAllDependencies(): Promise<TaskDependency[]> {
    return [...this.edges.values()].sort(
      (a, b) =>
        a.taskId.localeCompare(b.taskId) ||
        a.dependsOnTaskId.localeCompare(b.dependsOnTaskId),
    );
  }
}

function edgeKey(taskId: string, dependsOnTaskId: string): string {
  return `${taskId}\u0000${dependsOnTaskId}`;
}
