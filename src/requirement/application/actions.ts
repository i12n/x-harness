import type { CommandType, IntentAction } from "../../command/types.js";
import type { RequirementView } from "./resolver.js";

/**
 * TASK-1244: user-level action → internal commands.
 *
 * This is the only place that knows which machine objects an action touches, so
 * the language model never has to (and never gets to) name them. An action that
 * cannot be carried out as asked returns `ask` — a sentence for the user — so
 * the bot answers instead of guessing.
 */
export interface ResolvedRequirementCommand {
  type: CommandType;
  payload: Record<string, unknown>;
}

export interface RequirementActionOutcome {
  commands: ResolvedRequirementCommand[];
  /** Reply with this instead of executing (the action does not fit the stage). */
  ask?: string;
  /** True when the caller should render the requirement card instead of a command. */
  showCard?: boolean;
  /**
   * TASK-1252: the requirement has nothing to re-run yet — advance it instead
   * (derive the specification, plan the tasks). "开始做吧 / 重试生成规格" lands
   * here when the earlier derivation failed.
   */
  advance?: boolean;
}

export function commandsForRequirementAction(
  action: IntentAction,
  view: RequirementView | undefined,
): RequirementActionOutcome {
  switch (action.type) {
    case "create": {
      // TASK-1250: a *new* requirement never needs an existing one. This used
      // to sit behind "resolve the current requirement", so a fresh chat (or a
      // wiped database) answered "I don't know which one you mean" to a message
      // that was simply describing new work.
      const statement = asText(action.payload?.statement);
      if (!statement) {
        return { commands: [], ask: "请把要做的事说清楚一点，我好开单。" };
      }
      const repositoryId = asText(action.payload?.repositoryId);
      return {
        commands: [
          {
            type: "problem.create",
            payload: {
              title: titleFromStatement(statement),
              statement,
              ...(repositoryId ? { repositoryId } : {}),
            },
          },
        ],
      };
    }
    case "show":
      if (!view) {
        return { commands: [], ask: NO_REQUIREMENT_ASK };
      }
      return { commands: [], showCard: true };

    case "approve": {
      // TASK-1254: "通过 / 可以了 / 没问题" — the stage decides what is being
      // accepted. A task waiting for review is accepted (task → DONE); an
      // accepted delivery is published.
      if (!view) {
        return { commands: [], ask: NO_REQUIREMENT_ASK };
      }
      const reviewable = view.tasks.filter((task) => task.status === "REVIEW");
      if (reviewable.length === 1) {
        return {
          commands: [{ type: "review.approve", payload: { taskId: reviewable[0]!.id } }],
        };
      }
      if (reviewable.length > 1) {
        const options = reviewable.map((task) => task.title.slice(0, 20));
        return {
          commands: [],
          ask: `这项需求有 ${reviewable.length} 个开发点等你验收，通过哪些？[${options.join("] [")}] [全部]`,
        };
      }
      if (view.delivery?.status === "READY_FOR_RELEASE") {
        return {
          commands: [{ type: "deploy.promote", payload: { deliveryId: view.delivery.id } }],
        };
      }
      return {
        commands: [],
        ask:
          view.stage === "released"
            ? "这份需求已经上线了。"
            : "现在没有等你验收的东西——还在开发中，等跑完我会通知你。",
      };
    }

    case "reject": {
      if (!view) {
        return { commands: [], ask: NO_REQUIREMENT_ASK };
      }
      if (view.stage === "released") {
        // Shipped code is the freeze point: this is a new requirement, not a rework.
        return {
          commands: [],
          ask: "这份需求已经上线了，改不动了——直接说要改成什么，我开一个新需求。",
        };
      }
      const feedback = asText(action.payload?.feedback);
      // TASK-1249: anything that has stopped moving can be sent back — waiting
      // for review, finished, or stuck after exhausting its attempts. Only the
      // classic "reject a REVIEW task" case used to work, which is exactly the
      // moment a human most often wants to reject.
      const eligible = view.tasks.filter(
        (task) =>
          task.status === "REVIEW" || task.status === "DONE" || task.status === "BLOCKED",
      );
      const bound =
        view.boundTask && eligible.some((task) => task.id === view.boundTask!.id)
          ? [eligible.find((task) => task.id === view.boundTask!.id)!]
          : [];
      const targets = bound.length > 0 ? bound : eligible;
      if (targets.length === 0) {
        const running = view.tasks.filter(
          (task) => task.status === "RUNNING" || task.status === "VERIFYING",
        );
        return {
          commands: [],
          ask:
            running.length > 0
              ? "这项还在跑，等它跑完再打回（或者先说要停）。"
              : "现在还没有可打回的开发点；你要是想改需求，直接说要改成什么。",
        };
      }
      if (targets.length > 1) {
        // Precision beats guessing: ask which deliverable to redo, by title.
        const options = targets.map(
          (task) => `${task.title.slice(0, 20)}（${statusLabel(task.status)}）`,
        );
        return {
          commands: [],
          ask: `这项需求有 ${targets.length} 个开发点，重做哪些？[${options.join("] [")}] [全部]`,
        };
      }
      return {
        commands: [
          {
            type: "review.request_changes",
            payload: {
              taskId: targets[0]!.id,
              ...(feedback ? { feedback } : {}),
            },
          },
        ],
      };
    }

    case "deploy": {
      if (!view) {
        return { commands: [], ask: NO_REQUIREMENT_ASK };
      }
      if (!view.delivery) {
        return { commands: [], ask: "这次改动还没有形成交付，等开发完成我再推测试环境。" };
      }
      // TASK-1256: 已上线的交付没有可测试的内容（改动已合并进主分支），
      // 直接说清楚比让它去重建测试分支、再抛一个 git 错误好。
      if (view.delivery.status === "RELEASED") {
        return {
          commands: [],
          ask: "这份需求已经上线了，测试环境不用再部署——要改的话直接说要改什么，我开新需求。",
        };
      }
      return { commands: [{ type: "deploy.test", payload: { deliveryId: view.delivery.id } }] };
    }

    case "publish": {
      if (!view) {
        return { commands: [], ask: NO_REQUIREMENT_ASK };
      }
      if (!view.delivery) {
        return { commands: [], ask: "现在还没有可发布的东西。" };
      }
      if (view.delivery.status !== "READY_FOR_RELEASE") {
        return {
          commands: [],
          ask:
            view.delivery.status === "RELEASED"
              ? "这份需求已经上线了。"
              : "测试环境还没验收通过，先「测试部署」看一下效果吧。",
        };
      }
      return {
        commands: [{ type: "deploy.promote", payload: { deliveryId: view.delivery.id } }],
      };
    }

    case "rerun": {
      if (!view) {
        return { commands: [], ask: NO_REQUIREMENT_ASK };
      }
      // Nothing to re-run yet: the bottleneck is upstream (no specification, or
      // a specification that never got planned). Advancing is what the user
      // means by "开始做吧" / "重试生成规格".
      if (!view.specification || view.tasks.length === 0) {
        if (!view.problemId) {
          return { commands: [], ask: "这项需求还没到能开工的阶段。" };
        }
        return { commands: [], advance: true };
      }
      const target = view.currentTask ?? view.tasks[0];
      if (!target) {
        return { commands: [], ask: "这项需求还没有可重跑的开发点。" };
      }
      return { commands: [{ type: "task.run", payload: { taskId: target.id } }] };
    }

    case "chat":
    case "clarify":
      return { commands: [] };
  }
}

/** Said when the user asked to act on "the thing" and nothing is bound. */
const NO_REQUIREMENT_ASK =
  "这条会话还没有对应的需求——你要是想新做点什么，直接描述就行，我来开单。";

/** First line, trimmed to something short enough for a card title. */
export function titleFromStatement(statement: string): string {
  const firstLine = statement.split(/\r?\n/)[0]?.trim() ?? "";
  const title = firstLine || statement.trim();
  return title.length <= 60 ? title : `${title.slice(0, 59)}…`;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusLabel(status: string): string {
  switch (status) {
    case "REVIEW":
      return "等人验收";
    case "DONE":
      return "已完成";
    case "BLOCKED":
      return "已阻塞";
    case "RUNNING":
      return "执行中";
    case "QUEUED":
      return "排队中";
    default:
      return status;
  }
}
