import type { Specification } from "../../domain/specification.js";
import type { SpecificationPlanItem } from "../../domain/specificationPlan.js";
import type { Task } from "../../domain/task.js";
import type { OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

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
      `Status: ${specification.status}`,
    ),
  ];
  if (specification.summary) {
    blocks.push(sectionBlock("Summary", specification.summary));
  }
  if (specification.requirements.length > 0) {
    blocks.push(
      markdownBlock(
        `**Requirements**\n${specification.requirements
          .map((requirement) => `- ${requirement}`)
          .join("\n")}`,
      ),
    );
  }
  if (specification.acceptance.length > 0) {
    blocks.push(
      markdownBlock(
        `**Acceptance**\n${specification.acceptance
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
              `- #${target.position} ${target.role} · ${repositoryName(
                target.repositoryId,
              )} (${target.repositoryId})` +
              (target.baseRef ? ` · base ${target.baseRef}` : ""),
          )
          .join("\n")
      : "(no targets)";
  blocks.push(markdownBlock(`**Targets**\n${targets}`));
  blocks.push(markdownBlock(`**Plan**\n${renderPlan(plan)}`));

  return {
    conversationId: options.conversationId ?? specification.id,
    text: `${specification.id} ${specification.title} (${specification.status})`,
    blocks,
  };
}

function renderPlan(plan: SpecificationPlanView): string {
  const items = plan.planItems ?? [];
  if (items.length === 0) {
    return "(not planned)";
  }
  const tasks = new Map((plan.tasks ?? []).map((task) => [task.id, task]));
  return items
    .map((item) => {
      const task = item.taskId ? tasks.get(item.taskId) : undefined;
      const link = item.taskId ?? "(no task)";
      const status = task ? ` · ${task.status}` : "";
      return `- #${item.position} ${item.title} → ${link}${status}`;
    })
    .join("\n");
}
