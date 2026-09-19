import { assessSpecification } from "../../domain/specification.js";
import type { Specification, SpecificationTarget } from "../../domain/specification.js";
import {
  planItemId,
  plannedTaskId,
} from "../../domain/specificationPlan.js";
import type { SpecificationPlanItem } from "../../domain/specificationPlan.js";
import type { Task } from "../../domain/task.js";
import { DuplicateTaskError } from "../../errors.js";
import type { EventStore } from "../../store/eventStore.js";
import type { SpecificationPlanStore } from "../../store/specificationPlanStore.js";
import type { SpecificationStore } from "../../store/specificationStore.js";
import type { TaskStore } from "../../store/taskStore.js";
import { SpecificationError } from "./service.js";
import type { TaskPlanner } from "./planner.js";

export interface PlanningServiceDeps {
  specifications: SpecificationStore;
  plans: SpecificationPlanStore;
  tasks: TaskStore;
  planner: TaskPlanner;
  events?: EventStore;
}

export interface PlanningOutcome {
  specification: Specification;
  planItems: SpecificationPlanItem[];
  tasks: Task[];
  /** True when an existing plan was returned instead of planning again. */
  replayed: boolean;
}

/** Newly planned Tasks start as INBOX: planning never schedules execution. */
const PLANNED_TASK_STATUS = "INBOX";

/**
 * TASK-1202: READY Specification → plan items → N Tasks.
 *
 * Idempotency is layered:
 *  1. an existing plan is returned as-is (`replayed: true`);
 *  2. READY → PLANNED happens through a compare-and-set, so only one caller
 *     can start planning a specification;
 *  3. plan items and Tasks use deterministic ids (`plan-…`/`task-…`), so a
 *     crash between creating a Task and linking it self-heals on the next call
 *     (UNIQUE(specification_id, position) / tasks.id are the DB backstop).
 *
 * No dependencies, no DAG, no scheduling, no run creation — TASK-1203+.
 */
export class PlanningService {
  constructor(private readonly deps: PlanningServiceDeps) {}

  async plan(specificationId: string): Promise<PlanningOutcome> {
    const specification = await this.deps.specifications.findSpecification(
      specificationId,
    );

    let items = await this.deps.plans.listPlanItems(specificationId);
    let replayed = items.length > 0;
    if (items.length === 0) {
      assertPlannable(specification);
      const claimed = await this.deps.specifications.updateSpecificationStatusIf(
        specificationId,
        "READY",
        "PLANNED",
      );
      if (!claimed) {
        throw new SpecificationError(
          "specification_not_ready",
          `specification ${specificationId} could not be claimed for planning`,
        );
      }
      const plan = await this.deps.planner.plan(specification);
      const planned = plan.items
        .map((item) => ({ title: item.title.trim(), description: item.description.trim() }))
        .filter((item) => item.title.length > 0);
      if (planned.length === 0) {
        await this.deps.specifications.updateSpecificationStatusIf(
          specificationId,
          "PLANNED",
          "READY",
        );
        throw new SpecificationError(
          "plan_empty",
          `planner produced no plan items for specification ${specificationId}`,
        );
      }
      for (const [position, item] of planned.entries()) {
        await this.deps.plans.createPlanItem({
          id: planItemId(specificationId, position),
          specificationId,
          position,
          title: item.title,
          description: item.description,
        });
      }
      items = await this.deps.plans.listPlanItems(specificationId);
      replayed = false;
      await this.emit("specification.planned", specification.problemId, specificationId, {
        planItems: items.length,
        titles: items.map((item) => item.title),
      });
    } else if (specification.status === "READY") {
      // Plan items exist but the specification is still READY: a previous
      // planning run was interrupted. Restore the consistent state.
      await this.deps.specifications.updateSpecificationStatusIf(
        specificationId,
        "READY",
        "PLANNED",
      );
    }

    const { tasks, created } = await this.materializeTasks(specification, items);
    const refreshed = await this.deps.specifications.findSpecification(specificationId);
    return {
      specification: refreshed,
      planItems: await this.deps.plans.listPlanItems(specificationId),
      tasks,
      replayed: replayed && created === 0,
    };
  }

  /** Read-only view: specification + its plan (if any). */
  async show(specificationId: string): Promise<{
    specification: Specification;
    planItems: SpecificationPlanItem[];
    tasks: Task[];
  }> {
    const specification = await this.deps.specifications.findSpecification(
      specificationId,
    );
    const planItems = await this.deps.plans.listPlanItems(specificationId);
    const tasks: Task[] = [];
    for (const item of planItems) {
      if (!item.taskId) {
        continue;
      }
      tasks.push(await this.deps.tasks.findTask(item.taskId));
    }
    return { specification, planItems, tasks };
  }

  /**
   * Creates one Task per plan item that does not have one yet. Task ids are
   * deterministic, so a duplicate id means "already created" rather than an
   * error (that is the recovery path after a crash mid-planning).
   */
  private async materializeTasks(
    specification: Specification,
    items: SpecificationPlanItem[],
  ): Promise<{ tasks: Task[]; created: number }> {
    const tasks: Task[] = [];
    let created = 0;
    for (const item of items) {
      if (item.taskId) {
        tasks.push(await this.deps.tasks.findTask(item.taskId));
        continue;
      }
      const taskId = plannedTaskId(specification.id, item.position);
      let task: Task;
      try {
        task = await this.deps.tasks.createTask({
          id: taskId,
          repositoryId: primaryRepositoryId(specification),
          targets: specification.targets.map(toTaskTargetInput),
          title: item.title,
          description: composeTaskDescription(
            specification.summary,
            item.description,
          ),
          status: PLANNED_TASK_STATUS,
          acceptance: specification.acceptance,
        });
        created += 1;
      } catch (error) {
        if (!(error instanceof DuplicateTaskError)) {
          throw error;
        }
        task = await this.deps.tasks.findTask(taskId);
      }
      await this.deps.plans.attachTask(item.id, task.id);
      tasks.push(task);
    }
    return { tasks, created };
  }

  private async emit(
    type: string,
    problemId: string,
    specificationId: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    try {
      await this.deps.events.record({
        type,
        problemId,
        payload: { specificationId, ...(payload as object) },
      });
    } catch {
      // History must never break planning.
    }
  }
}

function assertPlannable(specification: Specification): void {
  const assessment = assessSpecification(specification);
  if (specification.status !== "READY") {
    throw new SpecificationError(
      "specification_not_ready",
      `specification ${specification.id} must be READY to be planned ` +
        `(status is ${specification.status})`,
      assessment.issues,
    );
  }
  if (!assessment.ok) {
    throw new SpecificationError(
      "specification_incomplete",
      `specification ${specification.id} is incomplete: ${assessment.issues.join("; ")}`,
      assessment.issues,
    );
  }
}

function primaryRepositoryId(specification: Specification): string {
  const primary = specification.targets.find((target) => target.role === "primary");
  return (primary ?? specification.targets[0])!.repositoryId;
}

function toTaskTargetInput(target: SpecificationTarget) {
  return {
    repositoryId: target.repositoryId,
    role: target.role,
    position: target.position,
    baseRef: target.baseRef,
  };
}

/** `Task.description = Specification.summary + plan item description`. */
function composeTaskDescription(summary: string, item: string): string {
  const parts = [summary.trim(), item.trim()].filter((part) => part.length > 0);
  const unique: string[] = [];
  for (const part of parts) {
    if (!unique.includes(part)) {
      unique.push(part);
    }
  }
  return unique.join("\n\n");
}
