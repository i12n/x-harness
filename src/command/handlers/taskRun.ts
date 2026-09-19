import { RunNotCancellableError } from "../../errors.js";
import type { RunService } from "../../run/application/runService.js";
import type { TaskRunService } from "../../run/application/taskRunService.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface TaskRunHandlerDeps {
  taskRun: TaskRunService;
  runs: RunService;
}

/**
 * TASK-1108: task/run commands reuse the existing Task/Run application
 * services (and the existing Worker) — no execution logic lives here.
 */
export function createTaskRunCommandHandlers(
  deps: TaskRunHandlerDeps,
): Partial<Record<CommandType, CommandHandler>> {
  return {
    "task.show": async (payload) => {
      const described = await deps.taskRun.describeTask(String(payload.taskId));
      return {
        task: described.task,
        latestRun: described.latestRun ?? null,
        repositoryNames: described.repositoryNames,
      };
    },

    "task.run": async (payload) => {
      const outcome = await deps.taskRun.run(String(payload.taskId));
      return {
        runId: outcome.runId,
        run: outcome.run,
        targets: outcome.outcome.targets,
        workspaces: outcome.outcome.workspaces,
      };
    },

    "run.show": async (payload) => {
      const run = await deps.runs.show(String(payload.runId));
      return { run };
    },

    "run.cancel": async (payload, command) => {
      try {
        const outcome = await deps.runs.cancel(String(payload.runId), {
          channel: command.actor.channel,
          userId: command.actor.userId,
        });
        return {
          run: outcome.run,
          cancelStatus: outcome.status,
          alreadyRequested: outcome.alreadyRequested,
        };
      } catch (error) {
        if (error instanceof RunNotCancellableError) {
          throw new CommandRejectionError("run_not_cancellable", error.message);
        }
        throw error;
      }
    },
  };
}
