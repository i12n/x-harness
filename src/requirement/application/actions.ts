import type { CommandType, IntentAction } from "../../command/types.js";
import type { Task } from "../../domain/task.js";
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

/**
 * TASK-1259: one thing the user can do right now, with the sentence that says
 * what it will do. The card renderer and the button handler both read this
 * list, so the prompt ("下一步会做什么") and the buttons can never disagree.
 */
export interface RequirementActionOption {
  type: IntentAction["type"];
  label: string;
  /** One concrete sentence: what happens, where, how long. Shown as 下一步. */
  nextStep: string;
  style?: "primary" | "danger" | "default";
}

/**
 * The actions that make sense at this stage, the recommended one first.
 *
 * Stages with nothing to ask (`released`) return an empty list — the card then
 * says what to do in words instead of offering a button that cannot work.
 */
export function requirementActionPlan(view: RequirementView): RequirementActionOption[] {
  switch (view.stage) {
    case "clarifying":
      return [];
    case "developing":
      return [
        {
          type: "show",
          label: "看看进展",
          nextStep: "看当前这轮的进展与最近一次结论（不会改动任何东西）",
          style: "primary",
        },
        {
          type: "rerun",
          label: "重跑",
          nextStep: "从 origin/main 新建工作区，重新跑一轮开发",
        },
      ];
    case "awaiting_acceptance":
      return [
        {
          type: "deploy",
          label: "推测试环境",
          nextStep:
            "把这次改动推到 test 分支、开/更新 PR 并部署到测试环境，完成后把地址发在这里（约 2 分钟）",
          style: "primary",
        },
        {
          type: "approve",
          label: "通过",
          nextStep: "直接接受这次改动，交付转为「待发布」（这一步还不会上线）",
        },
        {
          type: "reject",
          label: "打回并说明问题",
          nextStep: "带上你的意见回到开发并自动重跑一轮；请接着把问题说清楚",
          style: "danger",
        },
      ];
    case "awaiting_release":
      return [
        {
          type: "publish",
          label: "发布",
          nextStep:
            "合并 PR 到 main 并触发生产部署；部署成功后交付标记为已上线（约 3–5 分钟）",
          style: "primary",
        },
        {
          type: "deploy",
          label: "再看测试环境",
          nextStep: "重新部署一次测试环境（改动有更新时会同步更新 PR）",
        },
        {
          type: "reject",
          label: "打回并说明问题",
          nextStep: "带上你的意见回到开发并自动重跑一轮；请接着把问题说清楚",
          style: "danger",
        },
      ];
    case "released":
      return [];
  }
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
        // TASK-1267: the same rule as 打回 — how the work was split is not the
        // user's problem. 「通过」 accepts what is in front of them, so approve
        // all of it instead of asking which one they mean.
        return {
          commands: [
            {
              type: "review.approve_batch",
              payload: { taskIds: reviewable.map((task) => task.id) },
            },
          ],
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
      // TASK-1267: at an acceptance stage the opinion is about *the delivery*,
      // not about which task to reopen. It becomes one more round of work on
      // top of what the user is looking at — nothing is sent back to be
      // implemented again, and nothing already accepted is rewritten. The user
      // never sees, or answers, how the work was split into tasks.
      if (view.delivery && view.tasks.length > 0 && view.tasks.every((task) => task.status === "DONE")) {
        if (!feedback) {
          // Not a task question: we genuinely do not know what to change yet.
          return {
            commands: [],
            ask: "要改哪儿？说一下（改什么、期望是什么），我这就按你说的改。",
          };
        }
        return {
          commands: [
            {
              type: "delivery.revise",
              payload: { deliveryId: view.delivery.id, statement: feedback },
            },
          ],
        };
      }
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
              : "现在还没有可打回的东西；你要是想改需求，直接说要改成什么。",
        };
      }
      if (targets.length === 1) {
        return { commands: [rework(targets[0]!.id, feedback)] };
      }
      // TASK-1267: how this delivery was split into deliverables is the
      // harness's implementation detail — the user never sees it and must never
      // be asked about it. The targets are read out of their own words: whoever
      // their complaint names gets sent back, and a complaint that names nobody
      // falls back to the deliverable they were just looking at.
      const scope = asText(action.payload?.scope);
      const item = asText(action.payload?.item);
      const chosen = scope === "all" ? targets : pickTargets(
        scope === "item" ? (item ?? feedback) : feedback,
        targets,
        view.currentTask,
      );
      return { commands: chosen.map((task) => rework(task.id, feedback)) };
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
        return { commands: [], ask: "这项需求还没有可重跑的。" };
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

/**
 * TASK-1267: the numbered forms a user may use when they *volunteer* a scope
 * (「只改第二个」). Nothing is ever printed back as a numbered question — the
 * harness decides the scope itself; these are only accepted as input.
 */
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"] as const;

const CN_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * A title only counts as "the user named this deliverable" when the user's own
 * words share a run this long with it. Below it, matches are vocabulary both
 * deliverables have in common (「下载按钮」), which must never decide a scope.
 */
const MIN_TITLE_MATCH = 4;

function rework(taskId: string, feedback: string | undefined): ResolvedRequirementCommand {
  return {
    type: "review.request_changes",
    payload: { taskId, ...(feedback ? { feedback } : {}) },
  };
}

/**
 * TASK-1267: which deliverables does this text mean? Deliberately deterministic
 * and deliberately never empty:
 *
 * 1. an option number (「①」/「2」/「第二个」) or an exact task id names one;
 * 2. otherwise every deliverable whose title shares a ≥4-character run with the
 *    user's words, keeping only the best-scoring tier — a complaint that names
 *    one thing sends one back, a complaint that names two sends two;
 * 3. a complaint that names nothing (「打回」 with no words) falls back to the
 *    deliverable the user was just looking at.
 */
function pickTargets(
  needle: string | undefined,
  targets: Task[],
  fallback: Task | undefined,
): Task[] {
  const text = needle?.trim();
  if (text) {
    const index = optionIndexOf(text, targets.length);
    if (index !== undefined) {
      return [targets[index]!];
    }
    const byId = targets.find((task) => task.id === text);
    if (byId) {
      return [byId];
    }
    const ranked = targets
      .map((task) => ({ task, score: longestSharedRun(text, task.title) }))
      .filter((entry) => entry.score >= MIN_TITLE_MATCH)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best) {
      return ranked
        .filter((entry) => entry.score === best.score)
        .map((entry) => entry.task);
    }
  }
  const named = fallback && targets.find((task) => task.id === fallback.id);
  return [named ?? targets[0]!];
}

/** TASK-1267: 「①」/「1」/「第二个」/「2.」 → a 0-based deliverable index. */
function optionIndexOf(text: string, count: number): number | undefined {
  const trimmed = text.trim().replace(/[。.!！]$/, "");
  const circled = CIRCLED.indexOf(trimmed as (typeof CIRCLED)[number]);
  if (circled >= 0) {
    return circled < count ? circled : undefined;
  }
  const digits = /^(\d{1,2})\s*[.、)）]?$/.exec(trimmed);
  if (digits) {
    const value = Number(digits[1]);
    return value >= 1 && value <= count ? value - 1 : undefined;
  }
  const chinese = /^第\s*([一二三四五六七八九1-9])\s*(个|条|项)?$/.exec(trimmed);
  if (chinese) {
    const token = chinese[1]!;
    const value = CN_NUMBERS[token] ?? Number(token);
    return value >= 1 && value <= count ? value - 1 : undefined;
  }
  return undefined;
}

/** Longest run of characters the two strings have in common. */
function longestSharedRun(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const character of a) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (character === b[j - 1]) {
        current[j] = previous[j - 1]! + 1;
        if (current[j]! > best) {
          best = current[j]!;
        }
      }
    }
    previous = current;
  }
  return best;
}
