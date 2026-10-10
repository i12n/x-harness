import { assessTask } from "../../domain/task.js";
import type { Task, TaskStatus } from "../../domain/task.js";
import type { EventStore } from "../../store/eventStore.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { TaskStore } from "../../store/taskStore.js";

export interface TaskIntakeOutcome {
  task: Task;
  issues: string[];
}

export interface TaskIntakeDeps {
  tasks: TaskStore;
  repositories: RepositoryStore;
  events?: EventStore;
}

/**
 * TASK-1219: Task Intake (plan section 九), lifted out of the CLI command so
 * planning can run it automatically.
 *
 * INBOX -> READY when the repository exists and the task carries a description
 * plus acceptance criteria; otherwise INBOX -> BLOCKED with the reasons kept.
 * A planned task that cannot pass intake is exactly the case a human must see,
 * so the issues travel with the outcome instead of only being printed.
 */
export class TaskIntakeService {
  constructor(private readonly deps: TaskIntakeDeps) {}

  async intake(taskId: string): Promise<TaskIntakeOutcome> {
    const task = await this.deps.tasks.findTask(taskId);
    const issues: string[] = [];

    try {
      await this.deps.repositories.findRepository(task.repositoryId);
    } catch {
      issues.push(`没有找到仓库：${task.repositoryId}`);
    }
    issues.push(...assessTask(task).issues);

    const status: TaskStatus = issues.length === 0 ? "READY" : "BLOCKED";
    const updated = await this.deps.tasks.updateTaskStatus(task.id, status);
    await this.record(updated, issues);
    return { task: updated, issues };
  }

  /**
   * Intake several tasks in order. One bad task must not stop the others: each
   * outcome is reported and the caller decides what to surface.
   */
  async intakeAll(taskIds: string[]): Promise<TaskIntakeOutcome[]> {
    const outcomes: TaskIntakeOutcome[] = [];
    for (const taskId of taskIds) {
      outcomes.push(await this.intake(taskId));
    }
    return outcomes;
  }

  private async record(task: Task, issues: string[]): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    try {
      await this.deps.events.record({
        type: task.status === "READY" ? "TaskReady" : "TaskBlocked",
        taskId: task.id,
        payload: { issues },
      });
    } catch {
      // History must never break intake validation.
    }
  }
}
