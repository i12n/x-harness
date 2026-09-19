import type { Run } from "../../domain/run.js";
import { readTaskReviews, type Task, type TaskReview } from "../../domain/task.js";
import { HarnessError } from "../../errors.js";
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

export interface ReviewServiceDeps {
  tasks: TaskStore;
  /** Required for requestChanges (attempt accounting); optional otherwise. */
  runs?: RunStore;
  events?: EventStore;
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
    if (task.status !== "REVIEW") {
      throw new HarnessError(
        `task ${taskId} must be REVIEW to request changes (status is ${task.status})`,
      );
    }
    if (!this.deps.runs) {
      throw new HarnessError("requestChanges requires a run store");
    }
    const attempts = (await this.deps.runs.listRuns({ taskId })).length;
    const next: Task["status"] = attempts >= task.maxAttempts ? "BLOCKED" : "READY";
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
