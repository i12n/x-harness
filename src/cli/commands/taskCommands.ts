import type { CreateTaskInput, Task, TaskStatus } from "../../domain/task.js";
import { assessTask } from "../../domain/task.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { TaskListFilter, TaskStore } from "../../store/taskStore.js";

export interface TaskCreateOptions {
  id?: string;
  repo: string;
  title: string;
  description?: string;
  accept?: string[];
  priority?: number;
  maxAttempts?: number;
}

export async function createTaskCommand(
  tasks: TaskStore,
  repositories: RepositoryStore,
  options: TaskCreateOptions,
): Promise<Task> {
  // Task must be bound to a registered repository (Phase 2 acceptance).
  await repositories.findRepository(options.repo);
  const input: CreateTaskInput = {
    id: options.id,
    repositoryId: options.repo,
    title: options.title,
    description: options.description,
    acceptance: options.accept ?? [],
    priority: options.priority,
    maxAttempts: options.maxAttempts,
  };
  return tasks.createTask(input);
}

export async function listTasksCommand(
  tasks: TaskStore,
  filter: TaskListFilter,
): Promise<Task[]> {
  return tasks.listTasks(filter);
}

export async function showTaskCommand(tasks: TaskStore, id: string): Promise<Task> {
  return tasks.findTask(id);
}

export interface ValidateTaskResult {
  task: Task;
  issues: string[];
}

/**
 * Task Intake (plan section 九): INBOX -> READY when the repository exists and
 * description/acceptance are present, otherwise INBOX -> BLOCKED.
 */
export async function validateTaskCommand(
  tasks: TaskStore,
  repositories: RepositoryStore,
  id: string,
): Promise<ValidateTaskResult> {
  const task = await tasks.findTask(id);
  const issues: string[] = [];

  try {
    await repositories.findRepository(task.repositoryId);
  } catch {
    issues.push(`repository not found: ${task.repositoryId}`);
  }

  issues.push(...assessTask(task).issues);

  const status: TaskStatus = issues.length === 0 ? "READY" : "BLOCKED";
  const updated = await tasks.updateTaskStatus(task.id, status);
  return { task: updated, issues };
}
