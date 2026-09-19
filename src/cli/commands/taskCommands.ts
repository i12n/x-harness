import type { CreateTaskInput, Task, TaskStatus } from "../../domain/task.js";
import type { CreateTaskTargetInput } from "../../domain/taskTarget.js";
import { assessTask } from "../../domain/task.js";
import { ValidationError } from "../../errors.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { EventStore } from "../../store/eventStore.js";
import type { TaskListFilter, TaskStore } from "../../store/taskStore.js";

export interface TaskCreateOptions {
  id?: string;
  /** Single repository (legacy) or the first of `repos`. */
  repo?: string;
  /** Repeatable --repo: first = primary, the rest = supporting. */
  repos?: string[];
  /** --base-ref <repositoryId>=<ref> mappings. */
  baseRefs?: Record<string, string>;
  title: string;
  description?: string;
  accept?: string[];
  priority?: number;
  maxAttempts?: number;
}

/**
 * TASK-1011: CLI/API entry point for multi-repository targets. The CLI only
 * parses flags; roles, ordering and base-ref defaults are resolved here and
 * the domain (taskTarget.ts) enforces uniqueness / exactly-one-primary.
 */
export async function resolveTaskTargets(
  repositories: RepositoryStore,
  repos: string[],
  baseRefs: Record<string, string> = {},
): Promise<CreateTaskTargetInput[]> {
  const requested = repos.map((repoId) => repoId.trim()).filter(Boolean);
  if (requested.length === 0) {
    throw new ValidationError("at least one --repo is required");
  }
  const unknownBaseRefs = Object.keys(baseRefs).filter(
    (repoId) => !requested.includes(repoId),
  );
  if (unknownBaseRefs.length > 0) {
    throw new ValidationError(
      `--base-ref refers to repositories not passed via --repo: ${unknownBaseRefs.join(", ")}`,
    );
  }

  const targets: CreateTaskTargetInput[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const repositoryId = requested[index]!;
    const repository = await repositories.findRepository(repositoryId);
    targets.push({
      repositoryId,
      role: index === 0 ? "primary" : "supporting",
      position: index,
      // Default base ref is the repository's default branch; the workspace
      // layer performs the actual checkout.
      baseRef: baseRefs[repositoryId]?.trim() || repository.defaultBranch,
      required: true,
    });
  }
  return targets;
}

export async function createTaskCommand(
  tasks: TaskStore,
  repositories: RepositoryStore,
  options: TaskCreateOptions,
  events?: EventStore,
): Promise<Task> {
  const repos = options.repos ?? (options.repo ? [options.repo] : []);
  const targets = await resolveTaskTargets(repositories, repos, options.baseRefs);
  const input: CreateTaskInput = {
    id: options.id,
    targets,
    title: options.title,
    description: options.description,
    acceptance: options.accept ?? [],
    priority: options.priority,
    maxAttempts: options.maxAttempts,
  };
  const created = await tasks.createTask(input);
  if (events) {
    try {
      await events.record({
        type: "TaskCreated",
        taskId: created.id,
        payload: { repositoryId: created.repositoryId, title: created.title },
      });
    } catch {
      // History must never break task creation.
    }
  }
  return created;
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
  events?: EventStore,
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
  if (events) {
    try {
      await events.record({
        type: status === "READY" ? "TaskReady" : "TaskBlocked",
        taskId: task.id,
        payload: { issues },
      });
    } catch {
      // History must never break intake validation.
    }
  }
  return { task: updated, issues };
}
