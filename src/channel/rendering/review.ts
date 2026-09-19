import type { Run } from "../../domain/run.js";
import type { OutgoingMessage } from "../message.js";
import {
  collectRunTargets,
  markdownBlock,
  sectionBlock,
  statusMark,
  testCounts,
} from "./common.js";
import type { RenderOptions } from "./task.js";

export const REVIEW_ACTIONS = {
  approve: "review.approve",
  requestChanges: "review.request_changes",
} as const;

/**
 * TASK-1105: Review card. Buttons are structural placeholders only — approval
 * semantics (merge / rerun) belong to later tasks.
 */
export function renderReviewMessage(
  run: Run,
  options: RenderOptions = {},
): OutgoingMessage {
  const targets = collectRunTargets(run);
  const { passed, failed } = testCounts(targets);
  const blocks = [
    sectionBlock(`${run.id} · Ready for Review`, `Task: ${run.taskId}`),
  ];

  const targetLines =
    targets.length > 0
      ? targets
          .map(
            (target) =>
              `- ${statusMark(target.passed)} ${
                target.repository ?? target.repositoryId
              } (${target.role ?? "supporting"})`,
          )
          .join("\n")
      : "(no target details recorded)";
  blocks.push(markdownBlock(`**Targets**\n${targetLines}`));
  blocks.push(
    markdownBlock(`**Verification**\n- ${passed} passed\n- ${failed} failed`),
  );
  blocks.push({
    type: "actions",
    actions: [
      { id: REVIEW_ACTIONS.approve, label: "Approve", style: "primary", value: run.id },
      {
        id: REVIEW_ACTIONS.requestChanges,
        label: "Request Changes",
        style: "danger",
        value: run.id,
      },
    ],
  });

  return {
    conversationId: options.conversationId ?? run.id,
    text: `${run.id} ready for review`,
    blocks,
  };
}
