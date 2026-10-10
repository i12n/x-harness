import type { Specification } from "../../domain/specification.js";
import type { SpecificationPlanItem } from "../../domain/specificationPlan.js";
import type { Task } from "../../domain/task.js";
import type { OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";
import {
  SECTION,
  specificationStatusLabel,
  targetRoleLabel,
  taskStatusLabel,
} from "./copy.js";

export interface SpecificationRenderOptions {
  /** Destination override; renderers do not know the channel. */
  conversationId?: string;
  repositoryNames?: Map<string, string>;
}

export interface SpecificationPlanView {
  planItems?: SpecificationPlanItem[];
  tasks?: Task[];
}

/**
 * TASK-1202: Specification business facts → OutgoingMessage. Planning is
 * shown as facts (plan item → task id → task status); the renderer never
 * decides whether the plan should run.
 */
export function renderSpecificationMessage(
  specification: Specification,
  plan: SpecificationPlanView = {},
  options: SpecificationRenderOptions = {},
): OutgoingMessage {
  const repositoryName = (repositoryId: string): string =>
    options.repositoryNames?.get(repositoryId) ?? repositoryId;

  const blocks = [
    sectionBlock(
      `${specification.id} · ${specification.title}`,
      `${SECTION.status}：${specificationStatusLabel(specification.status)}`,
    ),
  ];
  if (specification.summary) {
    blocks.push(sectionBlock(SECTION.summary, specification.summary));
  }
  if (specification.requirements.length > 0) {
    blocks.push(
      markdownBlock(
        `**${SECTION.requirements}**\n${specification.requirements
          .map((requirement) => `- ${requirement}`)
          .join("\n")}`,
      ),
    );
  }
  if (specification.acceptance.length > 0) {
    blocks.push(
      markdownBlock(
        `**${SECTION.acceptance}**\n${specification.acceptance
          .map((item) => `- ${item}`)
          .join("\n")}`,
      ),
    );
  }
  const targets =
    specification.targets.length > 0
      ? specification.targets
          .map(
            (target) =>
              `- #${target.position} ${targetRoleLabel(target.role)} · ${repositoryName(
                target.repositoryId,
              )} (${target.repositoryId})` +
              (target.baseRef ? ` · 基线 ${target.baseRef}` : ""),
          )
          .join("\n")
      : "（没有目标仓库）";
  blocks.push(markdownBlock(`**${SECTION.targets}**\n${targets}`));
  blocks.push(markdownBlock(`**${SECTION.plan}**\n${renderPlan(plan)}`));

  return {
    conversationId: options.conversationId ?? specification.id,
    text: `${specification.id} ${specification.title}（${specificationStatusLabel(
      specification.status,
    )}）`,
    blocks,
  };
}

function renderPlan(plan: SpecificationPlanView): string {
  const items = plan.planItems ?? [];
  if (items.length === 0) {
    return "（还没有拆解）";
  }
  const tasks = new Map((plan.tasks ?? []).map((task) => [task.id, task]));
  return items
    .map((item) => {
      const task = item.taskId ? tasks.get(item.taskId) : undefined;
      const link = item.taskId ?? "（还没有任务）";
      const status = task ? ` · ${taskStatusLabel(task.status)}` : "";
      return `- #${item.position} ${item.title} → ${link}${status}`;
    })
    .join("\n");
}
