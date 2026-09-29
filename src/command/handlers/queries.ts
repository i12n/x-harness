import {
  renderDeliveryListMessage,
  renderProblemListMessage,
  renderRunListMessage,
  type DeliveryListEntry,
  type ProblemListEntry,
  type RunListEntry,
} from "../../channel/rendering/queries.js";
import { PROBLEM_STATUSES } from "../../domain/problem.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface RunQueryPort {
  list(filter: { limit?: number; taskId?: string }): Promise<RunListEntry[]>;
}

export interface ProblemQueryPort {
  list(filter: { status?: string }): Promise<ProblemListEntry[]>;
}

export interface DeliveryQueryPort {
  list(): Promise<DeliveryListEntry[]>;
}

/**
 * The read-only "what is going on?" commands.
 *
 * Triage can classify a question correctly and still have nowhere to send it —
 * that is exactly how 「当前有哪些仓库」 ended up answered with a help card. Every
 * question class the design lists must have a command behind it.
 */
export function createQueryCommandHandlers(deps: {
  runs: RunQueryPort;
  problems: ProblemQueryPort;
  deliveries: DeliveryQueryPort;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "run.list": async (payload) => {
      const limit = typeof payload.limit === "number" ? payload.limit : undefined;
      const taskId =
        typeof payload.taskId === "string" && payload.taskId.trim()
          ? payload.taskId.trim()
          : undefined;
      const runs = await deps.runs.list({ limit, taskId });
      return { runs, message: renderRunListMessage(runs, { taskId }) };
    },

    "problem.list": async (payload) => {
      const raw =
        typeof payload.status === "string" && payload.status.trim()
          ? payload.status.trim().toUpperCase()
          : undefined;
      if (raw && !(PROBLEM_STATUSES as readonly string[]).includes(raw)) {
        throw new CommandRejectionError(
          "invalid_problem_status",
          `状态 ${raw} 不存在（可选：${PROBLEM_STATUSES.join(" | ")}）`,
        );
      }
      const status = raw;
      const problems = await deps.problems.list({ status });
      return {
        problems,
        message: renderProblemListMessage(problems, {
          filterNote: status ? `状态 ${status}` : undefined,
        }),
      };
    },

    "delivery.list": async () => {
      const deliveries = await deps.deliveries.list();
      return { deliveries, message: renderDeliveryListMessage(deliveries) };
    },
  };
}
