import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";

export const TARGET_ROLES = ["primary", "supporting"] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];

/**
 * One repository a Task operates on. A Task has 1..n targets with exactly one
 * primary; `required` is always true in v1 (reserved for optional targets).
 */
export interface TaskTarget {
  id: string;
  taskId: string;
  repositoryId: string;
  role: TargetRole;
  position: number;
  baseRef?: string;
  required: boolean;
  createdAt: string;
}

export interface CreateTaskTargetInput {
  id?: string;
  taskId: string;
  repositoryId: string;
  role?: TargetRole;
  position?: number;
  baseRef?: string;
  required?: boolean;
}

export function isTargetRole(value: unknown): value is TargetRole {
  return typeof value === "string" && (TARGET_ROLES as readonly string[]).includes(value);
}

export function buildTaskTarget(input: CreateTaskTargetInput): TaskTarget {
  const taskId = input.taskId?.trim();
  if (!taskId) {
    throw new ValidationError("task target requires a task id");
  }
  const repositoryId = input.repositoryId?.trim();
  if (!repositoryId) {
    throw new ValidationError("task target requires a repository id");
  }
  const role = input.role ?? "primary";
  if (!isTargetRole(role)) {
    throw new ValidationError(`invalid target role: ${String(role)}`);
  }
  return {
    id: input.id?.trim() || makeId("tgt"),
    taskId,
    repositoryId,
    role,
    position: input.position ?? 0,
    baseRef: input.baseRef?.trim() || undefined,
    required: input.required ?? true,
    createdAt: new Date().toISOString(),
  };
}
