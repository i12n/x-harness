import type {
  DeliveryListEntry,
  ProblemListEntry,
  RunListEntry,
} from "../../channel/rendering/queries.js";
import type {
  DeliveryQueryPort,
  ProblemQueryPort,
  RunQueryPort,
} from "../../command/handlers/queries.js";
import { extractFailureEvidence } from "../../domain/failureEvidence.js";
import type { ProblemStatus } from "../../domain/problem.js";
import type { DeliveryService } from "../../delivery/application/service.js";
import type { DeliveryStore } from "../../store/deliveryStore.js";
import type { ProblemStore } from "../../store/problemStore.js";
import type { RunStore } from "../../store/runStore.js";
import type { SpecificationStore } from "../../store/specificationStore.js";
import type { TaskStore } from "../../store/taskStore.js";

export function createRunQueryPort(deps: {
  runs: RunStore;
  tasks: TaskStore;
  /** How many runs a bare 「最近发生了什么」 returns. */
  defaultLimit?: number;
}): RunQueryPort {
  const defaultLimit = deps.defaultLimit ?? 5;
  return {
    async list(filter): Promise<RunListEntry[]> {
      const runs = await deps.runs.listRuns(
        filter.taskId ? { taskId: filter.taskId } : undefined,
      );
      const recent = runs
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-Math.max(filter.limit ?? defaultLimit, 1))
        .reverse();

      const titles = new Map<string, string>();
      const entries: RunListEntry[] = [];
      for (const run of recent) {
        if (!titles.has(run.taskId)) {
          try {
            titles.set(run.taskId, (await deps.tasks.findTask(run.taskId)).title);
          } catch {
            titles.set(run.taskId, "(已删除)");
          }
        }
        const evidence = extractFailureEvidence(run);
        entries.push({
          id: run.id,
          taskId: run.taskId,
          taskTitle: titles.get(run.taskId) ?? run.taskId,
          status: run.status,
          attempt: run.attempt,
          finishedAt: run.finishedAt,
          createdAt: run.createdAt,
          failureSummary: evidence
            ? [evidence.message, evidence.command ? `\`${evidence.command}\`` : undefined]
                .filter(Boolean)
                .join(" ")
            : undefined,
        });
      }
      return entries;
    },
  };
}

export function createProblemQueryPort(deps: {
  problems: ProblemStore;
}): ProblemQueryPort {
  return {
    async list(filter): Promise<ProblemListEntry[]> {
      const problems = await deps.problems.listProblems(
        filter.status ? { status: filter.status as ProblemStatus } : undefined,
      );
      const entries: ProblemListEntry[] = [];
      for (const problem of problems) {
        const open = await deps.problems.listClarifications(problem.id, { status: "OPEN" });
        entries.push({
          id: problem.id,
          title: problem.title,
          status: problem.status,
          repositoryId: problem.repositoryId,
          openQuestions: open.length,
          updatedAt: problem.updatedAt,
        });
      }
      return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}

export function createDeliveryQueryPort(deps: {
  deliveries: DeliveryStore;
  specifications: SpecificationStore;
  service: DeliveryService;
}): DeliveryQueryPort {
  return {
    async list(): Promise<DeliveryListEntry[]> {
      const deliveries = await deps.deliveries.listDeliveries();
      const entries: DeliveryListEntry[] = [];
      for (const delivery of deliveries) {
        let title = delivery.specificationId;
        try {
          title = (await deps.specifications.findSpecification(delivery.specificationId)).title;
        } catch {
          // Deleted specification: fall back to the id.
        }
        // Recompute rather than trust a stored snapshot (TASK-1205 semantics).
        const view = await deps.service.load(delivery.id);
        entries.push({
          id: delivery.id,
          specificationId: delivery.specificationId,
          title,
          status: view.delivery.status,
          requiredTasks: view.requiredTasks.length,
          doneTasks: view.requiredTasks.filter((task) => task.status === "DONE").length,
        });
      }
      return entries;
    },
  };
}
