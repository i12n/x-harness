import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";
import { clampInt, dedupeNonEmpty } from "../util/strings.js";
import { buildTaskTarget } from "./taskTarget.js";
import type { CreateTaskTargetInput, TaskTarget } from "./taskTarget.js";

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
  /** Primary repository (derived from the primary target) — kept for compat. */
  repositoryId: string;
  targets: TaskTarget[];
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

/** Advisory review recorded against a task (human or reviewer agent). */
export interface TaskReview {
  at: string;
  runId: string;
  text: string;
}

const REVIEWS_KEY = "reviews";

export function readTaskReviews(task: Pick<Task, "constraints">): TaskReview[] {
  const raw = task.constraints[REVIEWS_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is TaskReview =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as TaskReview).at === "string" &&
      typeof (entry as TaskReview).runId === "string" &&
      typeof (entry as TaskReview).text === "string",
  );
}

export function withTaskReview(
  task: Pick<Task, "constraints">,
  review: TaskReview,
): Record<string, unknown> {
  return {
    ...task.constraints,
    [REVIEWS_KEY]: [...readTaskReviews(task), review],
  };
}

export interface CreateTaskInput {
  id?: string;
  /** Single-repository shorthand; ignored when `targets` is provided. */
  repositoryId?: string;
  targets?: CreateTaskTargetInput[];
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
  const title = input.title.trim();
  if (!title) {
    throw new ValidationError("task title is required");
  }
  const status = input.status ?? "INBOX";
  assertTaskStatus(status);

  const id = input.id?.trim() || makeId("task");
  const targets = normalizeTargets(id, input);
  const primary = targets.find((target) => target.role === "primary");
  if (!primary) {
    throw new ValidationError("task must have exactly one primary target");
  }
  const now = new Date().toISOString();
  return {
    id,
    repositoryId: primary.repositoryId,
    targets,
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

/** v1: exactly one primary, unique repositories, order = position. */
function normalizeTargets(taskId: string, input: CreateTaskInput): TaskTarget[] {
  const requested: CreateTaskTargetInput[] =
    input.targets && input.targets.length > 0
      ? input.targets
      : input.repositoryId
        ? [{ taskId, repositoryId: input.repositoryId, role: "primary" }]
        : [];
  if (requested.length === 0) {
    throw new ValidationError("task requires at least one repository target");
  }

  const seen = new Set<string>();
  const targets = requested.map((target, index) =>
    buildTaskTarget({
      id: target.id ?? `${taskId}-target-${index}`,
      taskId,
      repositoryId: target.repositoryId,
      role: target.role ?? (index === 0 ? "primary" : "supporting"),
      position: target.position ?? index,
      baseRef: target.baseRef,
      required: target.required ?? true,
    }),
  );
  for (const target of targets) {
    if (seen.has(target.repositoryId)) {
      throw new ValidationError(
        `task targets must not repeat a repository: ${target.repositoryId}`,
      );
    }
    seen.add(target.repositoryId);
  }
  const primaries = targets.filter((target) => target.role === "primary");
  if (primaries.length !== 1) {
    throw new ValidationError(
      `task must have exactly one primary target (found ${primaries.length})`,
    );
  }
  return [...targets].sort((a, b) => a.position - b.position);
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
