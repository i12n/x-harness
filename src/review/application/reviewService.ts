import type { Run } from "../../domain/run.js";
import { specificationIdOfTask } from "../../domain/specificationPlan.js";
import { readTaskReviews, type Task, type TaskReview } from "../../domain/task.js";
import { HarnessError } from "../../errors.js";
import type { DeliveryStore } from "../../store/deliveryStore.js";
import type { EventStore } from "../../store/eventStore.js";
import type { RunStore } from "../../store/runStore.js";
import type { TaskStore } from "../../store/taskStore.js";

export interface ReviewActor {
  channel: string;
  userId: string;
}

export interface ReviewShowOutcome {
  task: Task;
  latestRun?: Run;
  reviews: TaskReview[];
}

/**
 * TASK-1242: the owning Delivery's status for a Task, for both the chat session
 * and the CLI. Planned Task ids encode their Specification (`task-spec-x-0`), so
 * the delivery store is the only dependency.
 */
export function deliveryStatusForTask(
  deliveries: Pick<DeliveryStore, "findDeliveryBySpecification">,
): (taskId: string) => Promise<string | undefined> {
  return async (taskId: string) => {
    const specificationId = specificationIdOfTask(taskId);
    if (!specificationId) {
      return undefined;
    }
    const delivery = await deliveries.findDeliveryBySpecification(specificationId);
    return delivery?.status;
  };
}

export interface ReviewServiceDeps {
  tasks: TaskStore;
  /** Required for requestChanges (attempt accounting); optional otherwise. */
  runs?: RunStore;
  events?: EventStore;
  /**
   * TASK-1242: status of the Delivery that owns this Task, when the deployment
   * can resolve it. A RELEASED delivery is frozen — its Tasks must not be
   * reopened, because the code is already merged and shipped.
   */
  deliveryStatusForTask?: (taskId: string) => Promise<string | undefined>;
}

/**
 * TASK-1109: review/approval application service. Approval semantics
 * (merge/rerun) are intentionally not implemented here — only the existing
 * Task state transitions (REVIEW → DONE / READY|BLOCKED).
 */
export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  async show(taskId: string): Promise<ReviewShowOutcome> {
    const task = await this.deps.tasks.findTask(taskId);
    const runs = this.deps.runs ? await this.deps.runs.listRuns({ taskId }) : [];
    return {
      task,
      latestRun: runs[runs.length - 1],
      reviews: readTaskReviews(task),
    };
  }

  async approve(taskId: string, actor: ReviewActor, note?: string): Promise<Task> {
    const task = await this.deps.tasks.findTask(taskId);
    if (task.status !== "REVIEW") {
      throw new HarnessError(
        `task ${taskId} must be REVIEW to approve (status is ${task.status})`,
      );
    }
    const actorLabel = `${actor.channel}:${actor.userId}`;
    let updated = await this.deps.tasks.updateTaskStatus(taskId, "DONE");
    updated = await this.deps.tasks.appendTaskReview(taskId, {
      at: new Date().toISOString(),
      runId: "human-approval",
      text: `APPROVED: ${note?.trim() || "(no note)"} (by ${actorLabel})`,
    });
    await this.emit(updated, "review.approved", { actor: actorLabel, note: note ?? "" });
    return updated;
  }

  async requestChanges(
    taskId: string,
    actor: ReviewActor,
    feedback?: string,
  ): Promise<Task> {
    const task = await this.deps.tasks.findTask(taskId);
    // TASK-1242: acceptance keeps happening after the task is DONE — the test
    // environment is reviewed later, and "that is not what I wanted" has to have
    // an entrance. DONE is therefore reopenable by a human; RELEASED deliveries
    // are the real freeze point, and the release record is untouched here.
    if (task.status !== "REVIEW" && task.status !== "DONE") {
      throw new HarnessError(
        `task ${taskId} must be REVIEW or DONE to request changes (status is ${task.status})`,
      );
    }
    if (!this.deps.runs) {
      throw new HarnessError("requestChanges requires a run store");
    }
    if (task.status === "DONE" && this.deps.deliveryStatusForTask) {
      const status = await this.deps.deliveryStatusForTask(taskId);
      if (status === "RELEASED") {
        throw new HarnessError(
          `task ${taskId} 所属交付已发布（RELEASED），不能再打回——请开新需求描述这次的改动`,
        );
      }
    }
    // Reopening finished work is an explicit human call, so it is not capped by
    // the attempt budget — the budget exists to stop the *machine* from looping.
    const attempts = (await this.deps.runs.listRuns({ taskId })).length;
    const next: Task["status"] =
      task.status === "DONE" || attempts < task.maxAttempts ? "READY" : "BLOCKED";
    const actorLabel = `${actor.channel}:${actor.userId}`;
    let updated = await this.deps.tasks.updateTaskStatus(taskId, next);
    updated = await this.deps.tasks.appendTaskReview(taskId, {
      at: new Date().toISOString(),
      runId: "human-rejection",
      text: `CHANGES REQUESTED: ${feedback?.trim() || "(no feedback)"} (by ${actorLabel})`,
    });
    await this.emit(updated, "review.changes_requested", {
      actor: actorLabel,
      feedback: feedback ?? "",
      status: next,
    });
    return updated;
  }

  private async emit(task: Task, type: string, payload: unknown): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    try {
      await this.deps.events.record({ type, taskId: task.id, payload });
    } catch {
      // History must never break review.
    }
  }
}
