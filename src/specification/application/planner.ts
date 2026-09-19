import type { Specification } from "../../domain/specification.js";

/** One planned work unit produced by a planner (no Task ids yet). */
export interface PlannedItem {
  title: string;
  description: string;
}

export interface TaskPlan {
  items: PlannedItem[];
}

/**
 * TASK-1202: Task planning is replaceable. A real (LLM) planner can be
 * swapped in later without changing PlanningService; TASK-1202 ships a
 * deterministic, offline planner only.
 */
export interface TaskPlanner {
  plan(specification: Specification): Promise<TaskPlan>;
}

/**
 * Deterministic planner: one plan item per requirement (in order), or a
 * single plan item for the whole specification when there are no
 * requirements. No dependencies, no DAG — that is TASK-1203.
 */
export class DeterministicTaskPlanner implements TaskPlanner {
  async plan(specification: Specification): Promise<TaskPlan> {
    const requirements = specification.requirements
      .map((requirement) => requirement.trim())
      .filter((requirement) => requirement.length > 0);
    if (requirements.length === 0) {
      return {
        items: [{ title: specification.title, description: "" }],
      };
    }
    return {
      items: requirements.map((requirement) => ({
        title: firstLine(requirement),
        description: requirement,
      })),
    };
  }
}

/** Fixed/queued planner for tests and offline demos. */
export class ScriptedTaskPlanner implements TaskPlanner {
  constructor(private readonly plans: TaskPlan | TaskPlan[]) {
    this.queue = Array.isArray(plans) ? [...plans] : [];
    this.fallback = Array.isArray(plans) ? plans[plans.length - 1] : plans;
  }

  private readonly queue: TaskPlan[];
  private readonly fallback: TaskPlan | undefined;

  async plan(specification: Specification): Promise<TaskPlan> {
    void specification;
    const next = this.queue.shift() ?? this.fallback;
    if (!next) {
      throw new Error("ScriptedTaskPlanner has no plan left");
    }
    return { items: next.items.map((item) => ({ ...item })) };
  }
}

/** Task titles stay single-line; the full text stays in the description. */
function firstLine(text: string): string {
  const [line] = text.split(/\r?\n/);
  const title = (line ?? "").trim();
  return title || text;
}
