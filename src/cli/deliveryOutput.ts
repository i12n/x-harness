import type { Delivery, Release } from "../domain/delivery.js";
import type { Task } from "../domain/task.js";

export interface DeliveryViewLike {
  delivery: Delivery;
  tasks: Task[];
  requiredTasks?: Task[];
  optionalTasks?: Task[];
  blocking?: Task[];
  release?: Release;
}

/** TASK-1205: `delivery show` / `delivery release` output. */
export function formatDeliveryView(view: DeliveryViewLike): string[] {
  const { delivery } = view;
  const lines = [
    `Delivery: ${delivery.id}`,
    `Specification: ${delivery.specificationId}`,
    `Status: ${delivery.status}`,
    "",
    "Tasks:",
  ];
  if (view.tasks.length === 0) {
    lines.push("  (none)");
  }
  for (const task of view.tasks) {
    const mark =
      task.status === "DONE"
        ? "✓"
        : task.status === "BLOCKED" || task.status === "FAILED"
          ? "✗"
          : "○";
    lines.push(
      `  ${mark} ${task.id}  ${task.status.padEnd(10)} ${isOptional(task) ? "optional" : "required"}  ${task.title}`,
    );
  }
  if (view.blocking && view.blocking.length > 0) {
    lines.push("", "Blocking:");
    for (const task of view.blocking) {
      lines.push(`  ${task.id} is ${task.status}`);
    }
  }
  lines.push("", "Release:");
  if (view.release) {
    lines.push(
      `  ${view.release.id} · ${view.release.status}` +
        (view.release.releasedAt ? ` · ${view.release.releasedAt}` : "") +
        (view.release.createdBy ? ` · by ${view.release.createdBy}` : ""),
    );
  } else {
    lines.push("  (not released)");
  }
  return lines;
}

function isOptional(task: Task): boolean {
  const primary =
    task.targets.find((target) => target.role === "primary") ?? task.targets[0];
  return primary ? !primary.required : false;
}
