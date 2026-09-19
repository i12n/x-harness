import type { Specification } from "../domain/specification.js";
import type { SpecificationPlanItem } from "../domain/specificationPlan.js";
import type { Task } from "../domain/task.js";

export interface SpecificationPlanView {
  specification: Specification;
  planItems: SpecificationPlanItem[];
  tasks: Task[];
  replayed?: boolean;
}

/** TASK-1202: `spec show` / `spec plan` output (plan item → task). */
export function formatSpecificationPlan(view: SpecificationPlanView): string[] {
  const { specification, planItems, tasks } = view;
  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  const lines = [
    `${specification.id} · ${specification.title}`,
    `Status: ${specification.status}`,
  ];
  if (specification.summary) {
    lines.push(`Summary: ${specification.summary}`);
  }
  if (specification.acceptance.length > 0) {
    lines.push("Acceptance:");
    for (const item of specification.acceptance) {
      lines.push(`  - ${item}`);
    }
  }
  lines.push("Targets:");
  for (const target of specification.targets) {
    lines.push(
      `  #${target.position}  ${target.role.padEnd(10)} repository: ${target.repositoryId}` +
        (target.baseRef ? `  base_ref: ${target.baseRef}` : ""),
    );
  }
  lines.push("Plan:");
  if (planItems.length === 0) {
    lines.push("  (not planned)");
    return lines;
  }
  for (const item of planItems) {
    const task = item.taskId ? byTaskId.get(item.taskId) : undefined;
    lines.push(
      `  #${item.position}  ${item.title}` +
        `\n      task: ${item.taskId ?? "(none)"}${task ? `  status: ${task.status}` : ""}`,
    );
  }
  if (view.replayed !== undefined) {
    lines.push(`Replayed: ${view.replayed ? "yes" : "no"}`);
  }
  return lines;
}
