import { renderTaskListMessage, type TaskListEntry } from "../../channel/rendering/taskList.js";
import { TASK_STATUSES } from "../../domain/task.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface TaskQueryPort {
  list(filter: { status?: string; repositoryId?: string }): Promise<TaskListEntry[]>;
}

/**
 * The model (and people) reach for English synonyms; map the obvious ones
 * instead of rejecting a reasonable question.
 */
const STATUS_ALIASES: Record<string, string> = {
  IN_PROGRESS: "RUNNING",
  INPROGRESS: "RUNNING",
  RUNNING: "RUNNING",
  PENDING: "READY",
  TODO: "READY",
  REVIEWING: "REVIEW",
  COMPLETED: "DONE",
  FINISHED: "DONE",
  BLOCKED: "BLOCKED",
};

/** `task.list` — the "what am I working on?" view. Read-only, any role. */
export function createTaskListCommandHandlers(deps: {
  tasks: TaskQueryPort;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "task.list": async (payload) => {
      const raw =
        typeof payload.status === "string" && payload.status.trim()
          ? payload.status.trim().toUpperCase()
          : undefined;
      const status = raw ? (STATUS_ALIASES[raw] ?? raw) : undefined;
      if (status && !(TASK_STATUSES as readonly string[]).includes(status)) {
        throw new CommandRejectionError(
          "invalid_task_status",
          `状态 ${status} 不存在（可选：${TASK_STATUSES.join(" | ")}）`,
        );
      }
      const repositoryId =
        typeof payload.repositoryId === "string" && payload.repositoryId.trim()
          ? payload.repositoryId.trim()
          : undefined;

      const tasks = await deps.tasks.list({ status, repositoryId });
      const note = [status ? `状态 ${status}` : undefined, repositoryId]
        .filter(Boolean)
        .join(" · ");
      return {
        tasks,
        message: renderTaskListMessage(tasks, { filterNote: note || undefined }),
      };
    },
  };
}
