import type { Delivery, Release } from "../../domain/delivery.js";
import type { Task } from "../../domain/task.js";
import type { OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

export interface DeliveryRenderOptions {
  conversationId?: string;
}

export interface DeliveryRenderFacts {
  delivery: Delivery;
  tasks: Task[];
  blocking?: Task[];
  release?: Release;
}

/**
 * TASK-1205: Delivery aggregation facts → OutgoingMessage. The renderer only
 * displays what the application aggregated; it never computes delivery status
 * or decides whether a release should happen.
 */
export function renderDeliveryMessage(
  facts: DeliveryRenderFacts,
  options: DeliveryRenderOptions = {},
): OutgoingMessage {
  const { delivery } = facts;
  const blocks = [
    sectionBlock(
      `${delivery.id} · Delivery`,
      [`Specification: ${delivery.specificationId}`, `Status: ${delivery.status}`].join(
        "\n",
      ),
    ),
  ];

  const tasks =
    facts.tasks.length > 0
      ? facts.tasks
          .map(
            (task) =>
              `- ${taskMark(task)} ${task.id} ${task.title} · ${task.status}` +
              (isOptional(task) ? " · optional" : " · required"),
          )
          .join("\n")
      : "(no tasks)";
  blocks.push(markdownBlock(`**Tasks**\n${tasks}`));

  if (facts.blocking && facts.blocking.length > 0) {
    blocks.push(
      markdownBlock(
        `**Blocking**\n${facts.blocking
          .map((task) => `- ${task.id} is ${task.status}`)
          .join("\n")}`,
      ),
    );
  }

  const release = facts.release;
  blocks.push(
    markdownBlock(
      release
        ? `**Release**\n- ${release.id} · ${release.status}` +
            (release.releasedAt ? ` · ${release.releasedAt}` : "") +
            (release.createdBy ? ` · by ${release.createdBy}` : "")
        : "**Release**\n(not released)",
    ),
  );

  return {
    conversationId: options.conversationId ?? delivery.id,
    text: `${delivery.id} ${delivery.specificationId} (${delivery.status})`,
    blocks,
  };
}

function taskMark(task: Task): string {
  if (task.status === "DONE") {
    return "✓";
  }
  if (task.status === "BLOCKED" || task.status === "FAILED") {
    return "✗";
  }
  return "○";
}

function isOptional(task: Task): boolean {
  const primary =
    task.targets.find((target) => target.role === "primary") ?? task.targets[0];
  return primary ? !primary.required : false;
}
