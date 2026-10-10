import { readTaskReviews } from "../../domain/task.js";
import type { MessageBlock, OutgoingMessage } from "../message.js";
import { requirementActionPlan } from "../../requirement/application/actions.js";
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

/** TASK-1259: the stage as the user sees it (reused by the card-action replies). */
export function stageLabel(stage: RequirementStage): string {
  return STAGE_LABELS[stage];
}

/** TASK-1259: card button id carrying one requirement action. */
export const REQUIREMENT_NEXT_ACTION = "requirement.next";

export interface RequirementCardOptions {
  conversationId: string;
  /** Show the ids for troubleshooting (detail line). */
  includeIds?: boolean;
}

export function renderRequirementCard(
  view: RequirementView,
  options: RequirementCardOptions,
): OutgoingMessage {
  // TASK-1259: the requirement's own id is the tracking handle — it is always
  // shown (the internal spec/task/delivery ids stay in the optional detail line).
  const lines = [
    `📋 「${view.title}」— **${STAGE_LABELS[view.stage]}**${view.problemId ? ` · ${view.problemId}` : ""}`,
  ];
  const latest = latestReviewText(view);
  if (latest) {
    lines.push(`最近一次验收意见：${latest}`);
  }
  const plan = requirementActionPlan(view);
  const primary = plan.find((option) => option.style === "primary") ?? plan[0];
  if (primary) {
    // "下一步" must say what pressing it does, not just "继续".
    lines.push(`👉 下一步「${primary.label}」= ${primary.nextStep}`);
  } else if (view.stage === "released") {
    lines.push("已上线。要改什么直接描述一句，我会另开一条需求。");
  }
  const blocks: MessageBlock[] = lines.map((text) => ({ type: "markdown" as const, text }));
  if (plan.length > 0) {
    blocks.push({
      type: "actions",
      actions: plan.map((option) => ({
        id: REQUIREMENT_NEXT_ACTION,
        label: option.label,
        style: option.style ?? "default",
        value: JSON.stringify({
          requirementId: view.problemId,
          action: option.type,
          stage: view.stage,
        }),
      })),
    });
  }
  if (options.includeIds) {
    const ids = [
      view.specification?.id,
      view.delivery?.id,
      view.boundTask?.id,
    ].filter((id): id is string => Boolean(id));
    if (ids.length > 0) {
      blocks.push({ type: "markdown", text: `（排查详情：${ids.join(" · ")}）` });
    }
  }
  return { conversationId: options.conversationId, text: lines.join("\n"), blocks };
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
