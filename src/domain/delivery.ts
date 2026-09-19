import type { Task, TaskStatus } from "./task.js";
import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";

export const DELIVERY_STATUSES = [
  "PLANNED",
  "IN_PROGRESS",
  "READY_FOR_RELEASE",
  "BLOCKED",
  "RELEASED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const RELEASE_STATUSES = ["PENDING", "RELEASED", "CANCELLED"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/**
 * TASK-1205: one Delivery per Specification. The Delivery does not own Tasks —
 * it aggregates the Tasks produced by the Specification's plan.
 */
export interface Delivery {
  id: string;
  specificationId: string;
  /** Last observed aggregate; recomputed from Task facts on refresh. */
  status: DeliveryStatus;
  createdAt: string;
  updatedAt: string;
}

/** One human-confirmed release record. No publish/PR/merge side effects. */
export interface Release {
  id: string;
  deliveryId: string;
  status: ReleaseStatus;
  createdBy?: string;
  createdAt: string;
  releasedAt?: string;
}

export interface CreateDeliveryInput {
  id?: string;
  specificationId: string;
  status?: DeliveryStatus;
}

export interface CreateReleaseInput {
  id?: string;
  deliveryId: string;
  status?: ReleaseStatus;
  createdBy?: string;
  releasedAt?: string;
}

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return (
    typeof value === "string" && (DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

export function isReleaseStatus(value: unknown): value is ReleaseStatus {
  return (
    typeof value === "string" && (RELEASE_STATUSES as readonly string[]).includes(value)
  );
}

export function buildDelivery(input: CreateDeliveryInput): Delivery {
  const specificationId = input.specificationId?.trim();
  if (!specificationId) {
    throw new ValidationError("delivery requires a specification id");
  }
  const status = input.status ?? "PLANNED";
  if (!isDeliveryStatus(status)) {
    throw new ValidationError(`invalid delivery status: ${String(status)}`);
  }
  const now = new Date().toISOString();
  return {
    id: input.id?.trim() || makeId("dlv"),
    specificationId,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildRelease(input: CreateReleaseInput): Release {
  const deliveryId = input.deliveryId?.trim();
  if (!deliveryId) {
    throw new ValidationError("release requires a delivery id");
  }
  const status = input.status ?? "PENDING";
  if (!isReleaseStatus(status)) {
    throw new ValidationError(`invalid release status: ${String(status)}`);
  }
  return {
    id: input.id?.trim() || makeId("rel"),
    deliveryId,
    status,
    createdBy: input.createdBy?.trim() || undefined,
    createdAt: new Date().toISOString(),
    releasedAt:
      input.releasedAt ?? (status === "RELEASED" ? new Date().toISOString() : undefined),
  };
}

/** Task statuses that block a delivery (FAILED needs a human decision too). */
export const BLOCKING_TASK_STATUSES: TaskStatus[] = ["BLOCKED", "FAILED"];

/**
 * A Task counts as required when its primary target is required. Planning
 * produces required targets in v1; `required=false` on the primary target is
 * how an optional Task is expressed (no new Task field).
 */
export function isRequiredTask(task: Pick<Task, "targets">): boolean {
  const primary =
    task.targets.find((target) => target.role === "primary") ?? task.targets[0];
  return primary ? primary.required : true;
}

/**
 * TASK-1205: Delivery status is an aggregation of current Task facts.
 *
 *   no required tasks                        → PLANNED
 *   some required task BLOCKED/FAILED        → BLOCKED
 *   every required task DONE                 → READY_FOR_RELEASE
 *   otherwise                                → IN_PROGRESS
 *
 * Optional tasks never block. RELEASED is not computed here: it is a human
 * action recorded by the release flow.
 */
export function aggregateDeliveryStatus(tasks: Pick<Task, "status" | "targets">[]): DeliveryStatus {
  const required = tasks.filter(isRequiredTask);
  if (required.length === 0) {
    return "PLANNED";
  }
  if (required.some((task) => BLOCKING_TASK_STATUSES.includes(task.status))) {
    return "BLOCKED";
  }
  if (required.every((task) => task.status === "DONE")) {
    return "READY_FOR_RELEASE";
  }
  return "IN_PROGRESS";
}

/** Required tasks that keep a Delivery blocked (for rendering/audit). */
export function blockingTasks<T extends Pick<Task, "status" | "targets">>(
  tasks: T[],
): T[] {
  return tasks.filter(
    (task) => isRequiredTask(task) && BLOCKING_TASK_STATUSES.includes(task.status),
  );
}
