import { latestDeliveryProduct } from "../../delivery/application/product.js";
import type { DeliveryService } from "../../delivery/application/service.js";
import { buildRevision } from "../../domain/revision.js";
import type { Run } from "../../domain/run.js";
import type { CreateTaskInput, Task } from "../../domain/task.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

/**
 * Narrow ports rather than store types: handlers sit on the application
 * boundary (see tests/channelBoundary.test.ts), so the composition root owns
 * which store satisfies them.
 */
export interface RevisionTaskPort {
  createTask(input: CreateTaskInput): Promise<Task>;
}

export interface RevisionPlanPort {
  listPlanItems(specificationId: string): Promise<{ position: number; taskId?: string }[]>;
  createPlanItem(input: {
    specificationId: string;
    position: number;
    title: string;
    description?: string;
    taskId?: string;
  }): Promise<unknown>;
}

export interface RevisionEventPort {
  record(input: { type: string; taskId?: string; payload: unknown }): Promise<unknown>;
}

export interface RevisionHandlerDeps {
  deliveries: Pick<DeliveryService, "load" | "refresh">;
  tasks: RevisionTaskPort;
  plans: RevisionPlanPort;
  runs: { listRuns(filter: { taskId: string }): Promise<Run[]> };
  events?: RevisionEventPort;
}

/**
 * TASK-1267: the acceptance-stage opinion → one more round of work.
 *
 * The design rule this handler exists for: **the user's complaint is never
 * expressed as "which task do I send back"**. It becomes a revision — a new
 * Task in the same Specification whose worktree starts from the delivery's
 * current content, so the already-accepted parts are frozen and only the
 * opinion is addressed.
 */
export function createRevisionCommandHandlers(
  deps: RevisionHandlerDeps,
): Partial<Record<CommandType, CommandHandler>> {
  return {
    "delivery.revise": async (payload, command) => {
      const deliveryId = String(payload.deliveryId ?? "").trim();
      const statement = String(payload.statement ?? "").trim();
      if (!deliveryId || !statement) {
        throw new CommandRejectionError(
          "revision_invalid",
          "修订需要交付 id 和改动说明",
        );
      }

      const view = await deps.deliveries
        .load(deliveryId)
        .catch(() => undefined);
      if (!view) {
        throw new CommandRejectionError(
          "delivery_not_found",
          `找不到交付 ${deliveryId}`,
        );
      }
      if (view.delivery.status === "RELEASED") {
        throw new CommandRejectionError(
          "delivery_released",
          "这份交付已经上线了，改不动了——直接说要改成什么，我开一个新需求",
        );
      }

      const specificationId = view.delivery.specificationId;
      const items = await deps.plans.listPlanItems(specificationId);
      const position = items.reduce((max, item) => Math.max(max, item.position), -1) + 1;
      const taskId = `${taskIdPrefix(specificationId)}${position}`;

      // The revision starts from the delivery as it stands — the same worktree
      // the test branch was pushed from. Without a product yet there is nothing
      // to revise *on top of*, so the round starts from the default branch.
      const product = await latestDeliveryProduct(view.tasks, deps.runs);
      const repositoryId = product?.task.repositoryId ?? view.tasks[0]?.repositoryId;
      if (!repositoryId) {
        throw new CommandRejectionError(
          "revision_no_repository",
          "这份交付还没有可修订的仓库",
        );
      }

      const title = firstLine(statement);
      const input: CreateTaskInput = {
        id: taskId,
        repositoryId,
        title,
        description: statement,
        status: "READY",
        acceptance: [statement],
        constraints: buildRevision({
          ...(product?.branch ? { baseRef: product.branch } : {}),
          ...(product ? { baseRunId: product.run.id } : {}),
          previousFiles: product?.files ?? [],
        }),
        targets: [
          {
            taskId,
            repositoryId,
            role: "primary",
            ...(product?.branch ? { baseRef: product.branch } : {}),
          },
        ],
      };
      const task = await deps.tasks.createTask(input);
      await deps.plans.createPlanItem({
        specificationId,
        position,
        title,
        description: statement,
        taskId: task.id,
      });
      // Adding a not-yet-finished required task reopens the aggregate: the
      // delivery recomputes to IN_PROGRESS on its own (no extra state machine).
      const refreshed = await deps.deliveries.refresh(deliveryId);
      await deps.events?.record({
        type: "revision.created",
        taskId: task.id,
        payload: {
          deliveryId,
          by: `${command.actor.channel}:${command.actor.userId}`,
          statement,
          ...(product?.branch ? { baseRef: product.branch } : {}),
          ...(product ? { baseRunId: product.run.id } : {}),
        },
      });

      return {
        delivery: refreshed.delivery,
        task: task as Task,
        revision: {
          taskId: task.id,
          ...(product?.branch ? { baseRef: product.branch } : {}),
          ...(product ? { baseRunId: product.run.id } : {}),
          previousFiles: product?.files ?? [],
        },
        message: {
          conversationId: "",
          text:
            `📝 收到，这就按你说的改：${title}\n` +
            "改完我自动重跑并更新测试环境（同一个 PR）；上一轮已经通过的部分不动。",
        },
      };
    },
  };
}

/** `spec-1` → `task-spec-1-`, so the id stays resolvable to its Specification. */
function taskIdPrefix(specificationId: string): string {
  return `task-${specificationId}-`;
}

/** First line, trimmed to something usable as a card title. */
function firstLine(statement: string): string {
  const line = statement.split(/\r?\n/)[0]?.trim() ?? "";
  const title = line || statement.trim();
  return title.length <= 60 ? title : `${title.slice(0, 59)}…`;
}
