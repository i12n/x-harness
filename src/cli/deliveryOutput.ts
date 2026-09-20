import type { Delivery, Release } from "../domain/delivery.js";
import type { DeliveryBlockingFact } from "../domain/delivery.js";
import type { Task } from "../domain/task.js";

export interface DeliveryViewLike {
  delivery: Delivery;
  tasks: Task[];
  requiredTasks?: Task[];
  optionalTasks?: Task[];
  blocking?: Task[];
  /** TASK-1207: structured blocking reasons (chain + failure evidence). */
  blockingFacts?: DeliveryBlockingFact[];
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
    const fact = view.blockingFacts?.find((entry) => entry.taskId === task.id);
    const mark = fact
      ? "✗"
      : task.status === "DONE"
        ? "✓"
        : task.status === "BLOCKED" || task.status === "FAILED"
          ? "✗"
          : "○";
    const state =
      fact?.state === "dependency-blocked"
        ? `dependency-blocked${fact.blockingTaskIds.length > 0 ? ` (blocked by ${fact.blockingTaskIds.join(", ")})` : ""}`
        : task.status;
    lines.push(
      `  ${mark} ${task.id}  ${state.padEnd(10)} ${isOptional(task) ? "optional" : "required"}  ${task.title}`,
    );
  }
  const chains = collectChains(view.blockingFacts);
  if (chains.length > 0) {
    lines.push("", "Blocking chain:");
    for (const chain of chains) {
      chain.forEach((entry, index) => {
        if (index > 0) {
          lines.push("    ↓");
        }
        lines.push(
          `  ${entry.taskId}${entry.title ? ` ${entry.title}` : ""}` +
            (entry.status ? ` (${entry.status})` : "") +
            (entry.note ? ` — ${entry.note}` : ""),
        );
      });
    }
  } else if (view.blocking && view.blocking.length > 0) {
    lines.push("", "Blocking:");
    for (const task of view.blocking) {
      lines.push(`  ${task.id} is ${task.status}`);
    }
  }
  const failures = (view.blockingFacts ?? []).filter((fact) => fact.evidence);
  if (failures.length > 0) {
    lines.push("", "Failure:");
    for (const fact of failures) {
      const evidence = fact.evidence!;
      const owner =
        fact.state === "dependency-blocked" && fact.blockingTaskIds.length > 0
          ? fact.blockingTaskIds[0]!
          : fact.taskId;
      if (evidence.kind === "verification") {
        lines.push(
          `  ${owner}: verification: ${evidence.command ?? "(unknown)"}` +
            (evidence.exitCode !== undefined && evidence.exitCode !== null
              ? ` (exit ${evidence.exitCode})`
              : ""),
        );
      } else {
        lines.push(
          `  ${owner}: ${evidence.kind === "unknown" ? "failure" : evidence.kind}: ` +
            `${evidence.message ?? "(no details)"}`,
        );
      }
      if (evidence.output) {
        lines.push(`    ${evidence.output.split("\n")[0]}`);
      }
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

function collectChains(
  facts: DeliveryBlockingFact[] | undefined,
): DeliveryBlockingFact["chain"][] {
  const chains: DeliveryBlockingFact["chain"][] = [];
  const seen = new Set<string>();
  for (const fact of facts ?? []) {
    if (fact.state !== "dependency-blocked" || fact.chain.length < 2) {
      continue;
    }
    const key = fact.chain.map((entry) => entry.taskId).join(">");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    chains.push(fact.chain);
  }
  return chains;
}
