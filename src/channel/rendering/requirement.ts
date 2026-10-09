import { readTaskReviews } from "../../domain/task.js";
import type { OutgoingMessage } from "../message.js";
import type { RequirementStage, RequirementView } from "../../requirement/application/resolver.js";

/**
 * TASK-1244: the one card the user sees. Title + stage + the actions that make
 * sense *now*; internal ids live in a single collapsed detail line (they are for
 * troubleshooting, not for talking).
 */
const STAGE_LABELS: Record<RequirementStage, string> = {
  clarifying: "澄清中",
  developing: "开发中",
  awaiting_acceptance: "待验收",
  awaiting_release: "待发布",
  released: "已上线",
};

export interface RequirementCardOptions {
  conversationId: string;
  /** Show the ids for troubleshooting (detail line). */
  includeIds?: boolean;
}

export function renderRequirementCard(
  view: RequirementView,
  options: RequirementCardOptions,
): OutgoingMessage {
  const lines = [`📋 「${view.title}」— **${STAGE_LABELS[view.stage]}**`];
  const latest = latestReviewText(view);
  if (latest) {
    lines.push(`最近一次验收意见：${latest}`);
  }
  const actions = availableActions(view);
  if (actions.length > 0) {
    lines.push(`可以：${actions.join(" / ")}`);
  }
  if (options.includeIds) {
    const ids = [
      view.problemId,
      view.specification?.id,
      view.delivery?.id,
      view.boundTask?.id,
    ].filter((id): id is string => Boolean(id));
    if (ids.length > 0) {
      lines.push(`（详情：${ids.join(" · ")}）`);
    }
  }
  return { conversationId: options.conversationId, text: lines.join("\n") };
}

/** What the user can do at this stage — in their words, not command names. */
export function availableActions(view: RequirementView): string[] {
  switch (view.stage) {
    case "clarifying":
      return ["回答问题", "放弃"];
    case "developing":
      return ["看看进展", "重跑"];
    case "awaiting_acceptance":
      return ["测试部署", "看看进展"];
    case "awaiting_release":
      return ["发布", "打回并说明问题", "测试部署"];
    case "released":
      return ["提新需求"];
  }
}

function latestReviewText(view: RequirementView): string | undefined {
  const tasks = view.currentTask ? [view.currentTask, ...view.tasks] : view.tasks;
  for (const task of tasks) {
    const reviews = readTaskReviews(task);
    const latest = reviews[reviews.length - 1];
    if (latest?.text.trim()) {
      return latest.text.replace(/^(APPROVED|CHANGES REQUESTED):\s*/, "").trim();
    }
  }
  return undefined;
}
