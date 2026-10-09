import type { AgentEngine } from "../../agent/types.js";
import type { Repository } from "../../domain/repository.js";
import type { Run } from "../../domain/run.js";
import type { Task, TaskReview } from "../../domain/task.js";
import { HarnessError } from "../../errors.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { DeliveryStore } from "../../store/deliveryStore.js";
import type { EventStore } from "../../store/eventStore.js";
import type { RunStore } from "../../store/runStore.js";
import type { TaskStore } from "../../store/taskStore.js";
import type { WorkspaceManager } from "../../workspace/manager.js";
import { extractWorkspaceInfo } from "../../workspace/info.js";
import {
  ReviewService,
  deliveryStatusForTask,
} from "../../review/application/reviewService.js";

export interface ReviewRunParams {
  tasks: TaskStore;
  runs: RunStore;
  repositories: RepositoryStore;
  workspaceManager: WorkspaceManager;
  engine: AgentEngine;
  runId: string;
  events?: EventStore;
}

export interface ReviewOutcome {
  task: Task;
  review: TaskReview;
  diff: string;
}

/**
 * Reviewer Agent (v0.2): review a SUCCEEDED run's workspace diff. The review
 * is advisory evidence; a human approves or rejects the task afterwards.
 */
export async function reviewRunCommand(params: ReviewRunParams): Promise<ReviewOutcome> {
  const run = await params.runs.findRun(params.runId);
  if (run.status !== "SUCCEEDED") {
    throw new HarnessError(
      `only succeeded runs can be reviewed (run ${params.runId} is ${run.status})`,
    );
  }
  const task = await params.tasks.findTask(run.taskId);
  const repository = await params.repositories.findRepository(task.repositoryId);
  const workspaceInfo = extractWorkspaceInfo(run);
  if (!workspaceInfo) {
    throw new HarnessError(
      `run ${params.runId} has no recorded workspace path; cannot review`,
    );
  }

  const diff = await params.workspaceManager.showDiff(workspaceInfo.path);
  const prompt = composeReviewPrompt(task, repository, run, workspaceInfo.branch, diff);
  const result = await params.engine.execute({
    runId: run.id,
    task,
    repository,
    workspacePath: workspaceInfo.path,
    prompt,
  });
  const text = (result.stdout || result.stderr || "").trim();
  if (!text) {
    throw new HarnessError("reviewer produced no output");
  }

  const review: TaskReview = {
    at: new Date().toISOString(),
    runId: run.id,
    text: truncate(text, 100_000),
  };
  const updated = await params.tasks.appendTaskReview(task.id, review);
  if (params.events) {
    try {
      await params.events.record({
        type: "TaskReview",
        taskId: task.id,
        runId: run.id,
        payload: { text: review.text.slice(0, 2000) },
      });
    } catch {
      // History must never break reviewing.
    }
  }
  return { task: updated, review, diff };
}

export async function approveTaskCommand(
  tasks: TaskStore,
  taskId: string,
  note?: string,
  events?: EventStore,
): Promise<Task> {
  return new ReviewService({ tasks, events }).approve(
    taskId,
    { channel: "cli", userId: "cli" },
    note,
  );
}

export async function rejectTaskCommand(
  tasks: TaskStore,
  runs: RunStore,
  taskId: string,
  feedback?: string,
  events?: EventStore,
  deliveries?: Pick<DeliveryStore, "findDeliveryBySpecification">,
): Promise<Task> {
  return new ReviewService({
    tasks,
    runs,
    events,
    ...(deliveries ? { deliveryStatusForTask: deliveryStatusForTask(deliveries) } : {}),
  }).requestChanges(
    taskId,
    { channel: "cli", userId: "cli" },
    feedback,
  );
}

function composeReviewPrompt(
  task: Task,
  repository: Repository,
  run: Run,
  branch: string,
  diff: string,
): string {
  const sections: string[] = [];
  sections.push(
    "You are reviewing the changes an AI coding agent made for a task.",
  );
  sections.push(`Repository: ${repository.name} (${repository.url})`);
  sections.push(`Run: ${run.id} (workspace branch ${branch || "(unknown)"})`);
  sections.push(`Task: ${task.title}`);
  sections.push(`Task description:\n${task.description || "(none)"}`);
  if (task.acceptance.length > 0) {
    sections.push(
      `Acceptance criteria:\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  sections.push(`Changes to review:\n${diff || "(no changes detected)"}`);
  sections.push(
    "Do not modify any files. Check correctness, acceptance criteria coverage, " +
      "scope discipline, and obvious risks. Report findings and a clear " +
      "recommendation (approve or reject).",
  );
  return sections.join("\n\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}
