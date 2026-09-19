import type { Task } from "../../domain/task.js";
import type { OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

export interface RenderOptions {
  /** Destination override; renderers do not know the channel. */
  conversationId?: string;
  repositoryNames?: Map<string, string>;
}

/** TASK-1105: Task business facts → OutgoingMessage (no Feishu knowledge). */
export function renderTaskMessage(
  task: Task,
  options: RenderOptions = {},
): OutgoingMessage {
  const repositoryName = (repositoryId: string): string =>
    options.repositoryNames?.get(repositoryId) ?? repositoryId;

  const blocks = [
    sectionBlock(`${task.id} · ${task.title}`, `Status: ${task.status}`),
  ];
  const targets =
    task.targets.length > 0
      ? task.targets
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
  if (task.acceptance.length > 0) {
    blocks.push(
      markdownBlock(
        `**Acceptance**\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`,
      ),
    );
  }
  if (task.description) {
    blocks.push(sectionBlock("Description", task.description));
  }

  return {
    conversationId: options.conversationId ?? task.id,
    text: `${task.id} ${task.title} (${task.status})`,
    blocks,
  };
}
