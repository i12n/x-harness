import type { CreateTaskInput, Task, TaskStatus } from "../domain/task.js";

export interface TaskListFilter {
  repositoryId?: string;
  status?: TaskStatus;
}

/** Persistence contract for tasks. */
export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<Task>;
  listTasks(filter?: TaskListFilter): Promise<Task[]>;
  findTask(id: string): Promise<Task>;
  updateTaskStatus(id: string, status: TaskStatus): Promise<Task>;
}
