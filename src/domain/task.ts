import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";
import { clampInt, dedupeNonEmpty } from "../util/strings.js";

export const TASK_STATUSES = [
  "INBOX",
  "READY",
  "RUNNING",
  "VERIFYING",
  "REVIEW",
  "BLOCKED",
  "FAILED",
  "DONE",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** One unit of work bound to a repository. */
export interface Task {
  id: string;
  repositoryId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  acceptance: string[];
  constraints: Record<string, unknown>;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  id?: string;
  repositoryId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  acceptance?: string[];
  constraints?: Record<string, unknown>;
  maxAttempts?: number;
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function assertTaskStatus(value: TaskStatus): void {
  if (!isTaskStatus(value)) {
    throw new ValidationError(`invalid task status: ${String(value)}`);
  }
}

/** Build a fully-populated Task from create input, applying defaults. */
export function buildTask(input: CreateTaskInput): Task {
  const repositoryId = input.repositoryId.trim();
  if (!repositoryId) {
    throw new ValidationError("task repository id is required");
  }
  const title = input.title.trim();
  if (!title) {
    throw new ValidationError("task title is required");
  }
  const status = input.status ?? "INBOX";
  assertTaskStatus(status);

  const now = new Date().toISOString();
  return {
    id: input.id?.trim() || makeId("task"),
    repositoryId,
    title,
    description: input.description?.trim() ?? "",
    status,
    priority: clampInt(input.priority ?? 50, 0, 1000),
    acceptance: dedupeNonEmpty(input.acceptance ?? []),
    constraints: input.constraints ?? {},
    maxAttempts: clampInt(input.maxAttempts ?? 3, 1, 100),
    createdAt: now,
    updatedAt: now,
  };
}

export interface TaskValidationReport {
  ok: boolean;
  issues: string[];
}

/** Task Intake checks (plan section 九): description and acceptance required. */
export function assessTask(
  task: Pick<Task, "description" | "acceptance">,
): TaskValidationReport {
  const issues: string[] = [];
  if (!task.description.trim()) {
    issues.push("task has no description");
  }
  if (task.acceptance.length === 0) {
    issues.push("task has no acceptance criteria");
  }
  return { ok: issues.length === 0, issues };
}
