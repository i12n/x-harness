import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";

/**
 * One planned work unit of a Specification (Phase 12 / TASK-1202).
 * A plan item is the durable intent; `taskId` is filled in once the Task has
 * been created, so `Specification → PlanItem → Task` stays traceable without
 * hiding links inside `Task.constraints`.
 */
export interface SpecificationPlanItem {
  id: string;
  specificationId: string;
  position: number;
  title: string;
  description: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSpecificationPlanItemInput {
  id?: string;
  specificationId: string;
  position: number;
  title: string;
  description?: string;
  taskId?: string;
}

export function buildSpecificationPlanItem(
  input: CreateSpecificationPlanItemInput,
): SpecificationPlanItem {
  const specificationId = input.specificationId?.trim();
  if (!specificationId) {
    throw new ValidationError("plan item requires a specification id");
  }
  const title = input.title?.trim();
  if (!title) {
    throw new ValidationError("plan item requires a title");
  }
  if (!Number.isInteger(input.position) || input.position < 0) {
    throw new ValidationError(
      `plan item position must be a non-negative integer (got ${String(input.position)})`,
    );
  }
  const now = new Date().toISOString();
  return {
    id: input.id?.trim() || makeId("plan"),
    specificationId,
    position: input.position,
    title,
    description: input.description?.trim() ?? "",
    taskId: input.taskId?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Deterministic plan-item id: `plan-<specificationId>-<position>`. Task ids
 * derive from the same shape, which makes materialization idempotent even if a
 * process dies between creating a Task and linking it back.
 */
export function planItemId(specificationId: string, position: number): string {
  return `plan-${specificationId}-${position}`;
}

/** Deterministic task id for the plan item at `position`. */
export function plannedTaskId(specificationId: string, position: number): string {
  return `task-${specificationId}-${position}`;
}
