import type { Delivery, DeliveryStatus } from "../../domain/delivery.js";
import type { Problem } from "../../domain/problem.js";
import type { Specification } from "../../domain/specification.js";
import { specificationIdOfTask } from "../../domain/specificationPlan.js";
import type { Task } from "../../domain/task.js";
import type { ConversationStore } from "../../store/conversationStore.js";
import type { DeliveryStore } from "../../store/deliveryStore.js";
import type { ProblemStore } from "../../store/problemStore.js";
import type { RunStore } from "../../store/runStore.js";
import type { SpecificationPlanStore } from "../../store/specificationPlanStore.js";
import type { SpecificationStore } from "../../store/specificationStore.js";
import type { TaskStore } from "../../store/taskStore.js";

/**
 * TASK-1244: the user-facing object.
 *
 * The chat only ever talks about a *requirement*; problem / specification /
 * delivery / task / run are how the harness implements it, and the user is
 * never asked to name one. This resolver maps "what this conversation is about"
 * to those internal objects, and derives the single stage the user sees.
 */
export type RequirementStage =
  | "clarifying"
  | "developing"
  | "awaiting_acceptance"
  | "awaiting_release"
  | "released";

export interface RequirementView {
  /** The Problem id when known — the requirement's stable internal handle. */
  problemId?: string;
  title: string;
  stage: RequirementStage;
  problem?: Problem;
  specification?: Specification;
  delivery?: Delivery;
  tasks: Task[];
  /**
   * The task this conversation is explicitly bound to (`subject_type=task|run`).
   * Absent when the conversation is bound to the requirement itself.
   */
  boundTask?: Task;
  /**
   * The task an action should default to: the explicit binding, else the one
   * still moving, else the newest. Convenience, not a binding.
   */
  currentTask?: Task;
}

export interface RequirementResolver {
  resolve(conversationId: string): Promise<RequirementView | undefined>;
  /**
   * TASK-1259: the requirement behind a `prob-…` id — the user-facing handle.
   * Progress queries and stage actions resolve through this, so they work
   * regardless of which topic the message was typed in.
   */
  resolveByProblemId(problemId: string): Promise<RequirementView | undefined>;
}

export interface RequirementResolverDeps {
  conversations: Pick<ConversationStore, "findConversation">;
  problems: Pick<ProblemStore, "findProblem">;
  specifications: Pick<
    SpecificationStore,
    "findSpecification" | "findSpecificationByProblem"
  >;
  deliveries: Pick<
    DeliveryStore,
    "findDelivery" | "findDeliveryBySpecification"
  >;
  plans: Pick<SpecificationPlanStore, "listPlanItems">;
  runs?: Pick<RunStore, "findRun">;
  tasks: Pick<TaskStore, "findTask">;
}

export function createRequirementResolver(
  deps: RequirementResolverDeps,
): RequirementResolver {
  return {
    async resolve(conversationId: string): Promise<RequirementView | undefined> {
      const conversation = await deps.conversations
        .findConversation(conversationId)
        .catch(() => undefined);
      if (!conversation?.subjectType || !conversation.subjectId) {
        return undefined;
      }

      let boundTask: Task | undefined;
      let problem: Problem | undefined;
      let specification: Specification | undefined;

      if (conversation.subjectType === "task") {
        boundTask = await deps.tasks.findTask(conversation.subjectId).catch(() => undefined);
        if (boundTask) {
          specification = await specificationOfTask(deps, boundTask.id);
        }
      } else if (conversation.subjectType === "run" && deps.runs) {
        const run = await deps.runs.findRun(conversation.subjectId).catch(() => undefined);
        boundTask = run
          ? await deps.tasks.findTask(run.taskId).catch(() => undefined)
          : undefined;
        if (boundTask) {
          specification = await specificationOfTask(deps, boundTask.id);
        }
      } else if (conversation.subjectType === "problem") {
        problem = await deps.problems.findProblem(conversation.subjectId).catch(() => undefined);
        specification = await deps.specifications
          .findSpecificationByProblem(conversation.subjectId)
          .catch(() => undefined);
      }

      if (!problem && specification) {
        problem = await deps.problems
          .findProblem(specification.problemId)
          .catch(() => undefined);
      }
      if (!problem && !specification && !boundTask) {
        return undefined;
      }

      const delivery = specification
        ? await deps.deliveries
            .findDeliveryBySpecification(specification.id)
            .catch(() => undefined)
        : undefined;
      const tasks = specification ? await tasksOfSpecification(deps, specification.id) : [];
      return buildView({ problem, specification, delivery, tasks, boundTask });
    },

    async resolveByProblemId(problemId: string): Promise<RequirementView | undefined> {
      const problem = await deps.problems.findProblem(problemId).catch(() => undefined);
      if (!problem) {
        return undefined;
      }
      const specification = await deps.specifications
        .findSpecificationByProblem(problemId)
        .catch(() => undefined);
      const delivery = specification
        ? await deps.deliveries
            .findDeliveryBySpecification(specification.id)
            .catch(() => undefined)
        : undefined;
      const tasks = specification ? await tasksOfSpecification(deps, specification.id) : [];
      return buildView({ problem, specification, delivery, tasks });
    },
  };
}

/** One shape for both lookups, so the two paths cannot drift apart. */
function buildView(input: {
  problem?: Problem;
  specification?: Specification;
  delivery?: Delivery;
  tasks: Task[];
  boundTask?: Task;
}): RequirementView {
  const { problem, specification, delivery, tasks, boundTask } = input;
  const currentTask =
    boundTask ??
    (tasks.length > 0
      ? (tasks.find((task) => task.status !== "DONE") ?? tasks[tasks.length - 1])
      : undefined);
  return {
    ...(problem ? { problemId: problem.id, problem } : {}),
    title: problem?.title ?? specification?.title ?? boundTask?.title ?? "(未命名需求)",
    stage: deriveStage(problem, delivery, tasks),
    ...(specification ? { specification } : {}),
    ...(delivery ? { delivery } : {}),
    tasks,
    ...(boundTask ? { boundTask } : {}),
    ...(currentTask ? { currentTask } : {}),
  };
}

/** The single stage the user sees, derived from internal facts. */
export function deriveStage(
  problem: Problem | undefined,
  delivery: Delivery | undefined,
  tasks: Task[],
): RequirementStage {
  if (problem && problem.status !== "CONFIRMED") {
    return "clarifying";
  }
  const deliveryStatus: DeliveryStatus | undefined = delivery?.status;
  if (deliveryStatus === "RELEASED") {
    return "released";
  }
  if (deliveryStatus === "READY_FOR_RELEASE") {
    return "awaiting_release";
  }
  // TASK-1254: a task waiting for a human verdict *is* the acceptance stage —
  // showing "开发中" there made the card say the opposite of the truth.
  if (tasks.some((task) => task.status === "REVIEW")) {
    return "awaiting_acceptance";
  }
  if (tasks.length > 0 && tasks.every((task) => task.status === "DONE")) {
    return "awaiting_acceptance";
  }
  return "developing";
}

async function specificationOfTask(
  deps: RequirementResolverDeps,
  taskId: string,
): Promise<Specification | undefined> {
  const specificationId = specificationIdOfTask(taskId);
  return specificationId
    ? deps.specifications.findSpecification(specificationId).catch(() => undefined)
    : undefined;
}

async function tasksOfSpecification(
  deps: RequirementResolverDeps,
  specificationId: string,
): Promise<Task[]> {
  const items = await deps.plans.listPlanItems(specificationId).catch(() => []);
  const tasks: Task[] = [];
  for (const item of items) {
    if (!item.taskId) {
      continue;
    }
    const task = await deps.tasks.findTask(item.taskId).catch(() => undefined);
    if (task) {
      tasks.push(task);
    }
  }
  return tasks;
}
