import type { Task } from "../../domain/task.js";
import type { OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

/** Dependency facts a renderer may display (never queried from a store here). */
export interface TaskDependencyFacts {
  runnable: boolean;
  prerequisites: { id: string; title?: string; status: string }[];
}

export interface RenderOptions {
  /** Destination override; renderers do not know the channel. */
  conversationId?: string;
  repositoryNames?: Map<string, string>;
  /**
   * Why a READY task is (not) running right now — TASK-1204 visibility.
   * Omitted when the caller has no dependency view.
   */
  dependency?: TaskDependencyFacts;
}

/** TASK-1105: Task business facts → OutgoingMessage (no Feishu knowledge). */
export function renderTaskMessage(
  task: Task,
  options: RenderOptions = {},
): OutgoingMessage {
  const repositoryName = (repositoryId: string): string =>
    options.repositoryNames?.get(repositoryId) ?? repositoryId;

  const blocks = [
    sectionBlock(`${task.id} · ${task.title}`, renderHeader(task, options.dependency)),
  ];
  if (options.dependency && options.dependency.prerequisites.length > 0) {
    blocks.push(
      markdownBlock(
        `**Dependencies**\n${options.dependency.prerequisites
          .map(
            (prerequisite) =>
              `- ${prerequisite.status === "DONE" ? "✓" : "⏳"} ${prerequisite.id}` +
              (prerequisite.title ? ` ${prerequisite.title}` : "") +
              ` (${prerequisite.status})`,
          )
          .join("\n")}`,
      ),
    );
  }
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

function renderHeader(task: Task, dependency?: TaskDependencyFacts): string {
  const lines = [`Status: ${task.status}`];
  if (dependency) {
    lines.push(`Runnable: ${dependency.runnable ? "yes" : "no"}`);
  }
  return lines.join("\n");
}
