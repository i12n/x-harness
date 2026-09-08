import { buildTask, withTaskReview } from "../domain/task.js";
import type {
  CreateTaskInput,
  Task,
  TaskReview,
  TaskStatus,
} from "../domain/task.js";
import { DuplicateTaskError, TaskNotFoundError } from "../errors.js";
import type { TaskListFilter, TaskStore } from "./taskStore.js";

/** Non-persistent task store, used by tests and memory-mode demos. */
export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();

  async createTask(input: CreateTaskInput): Promise<Task> {
    const task = buildTask(input);
    if (this.tasks.has(task.id)) {
      throw new DuplicateTaskError(task.id);
    }
    this.tasks.set(task.id, task);
    return task;
  }

  async listTasks(filter: TaskListFilter = {}): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          (filter.repositoryId === undefined || task.repositoryId === filter.repositoryId) &&
          (filter.status === undefined || task.status === filter.status),
      )
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt.localeCompare(b.createdAt);
        }
        return a.id.localeCompare(b.id);
      });
  }

  async findTask(id: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new TaskNotFoundError(id);
    }
    return task;
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    const current = await this.findTask(id);
    const updated: Task = { ...current, status, updatedAt: new Date().toISOString() };
    this.tasks.set(id, updated);
    return updated;
  }

  async appendTaskReview(id: string, review: TaskReview): Promise<Task> {
    const current = await this.findTask(id);
    const updated: Task = {
      ...current,
      constraints: withTaskReview(current, review),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, updated);
    return updated;
  }
}
