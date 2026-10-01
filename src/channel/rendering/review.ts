import type { Run } from "../../domain/run.js";
import type { MessageBlock, OutgoingMessage } from "../message.js";
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

/** One card, many tasks: tick several and approve them in a single submit. */
export const REVIEW_BATCH_ACTION = "review.approve_batch";

export interface ReviewBatchEntry {
  id: string;
  title: string;
  repositoryName?: string;
}

export interface ReviewBatchResult {
  approved: string[];
  failed: { taskId: string; reason: string }[];
}

/**
 * TASK-1216: the batch review card. Every task waiting for review becomes an
 * option of one multi-select group, so a reviewer can clear several at once
 * instead of opening each task separately.
 */
export function renderReviewBatchMessage(
  tasks: ReviewBatchEntry[],
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock("待评审", `共 ${tasks.length} 个任务 · 勾选后点「通过所选」`),
    markdownBlock(
      tasks
        .map(
          (task) =>
            `- \`${task.id}\` ${task.title}` +
            (task.repositoryName ? ` · ${task.repositoryName}` : ""),
        )
        .join("\n"),
    ),
    {
      type: "choice",
      id: "review-batch",
      options: tasks.map((task) => ({
        id: task.id,
        label: `${task.id} ${task.title}`,
      })),
      multi: true,
      submit: {
        action: REVIEW_BATCH_ACTION,
        label: "通过所选",
        payload: {},
        selectionField: "taskIds",
      },
    },
  ];
  return {
    conversationId: options.conversationId ?? "review",
    text: `待评审 ${tasks.length} 个任务`,
    blocks,
  };
}

/** Per-task outcome of a batch approval, so partial failures stay visible. */
export function renderReviewBatchResultMessage(
  result: ReviewBatchResult,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const lines: string[] = [];
  if (result.approved.length > 0) {
    lines.push(`✅ 已通过 ${result.approved.length} 个：${result.approved.join("、")}`);
  }
  for (const failure of result.failed) {
    lines.push(`⚠️ ${failure.taskId} 未通过：${failure.reason}`);
  }
  return {
    conversationId: options.conversationId ?? "review",
    text: lines.join("\n") || "没有需要处理的任务。",
  };
}

/** What happened when a Task's worktree was committed/pushed (plain facts). */
export interface PublishView {
  repositoryId: string;
  branch: string;
  remote: string;
  committed: boolean;
  pushed: boolean;
  filesChanged: number;
  skipped?: string;
  message: string;
}

/** One line per repository, so a multi-repo Task reports each target. */
export function renderPublishLines(outcomes: PublishView[]): string[] {
  return outcomes.map((outcome) => {
    const mark = outcome.pushed ? "⬆️" : outcome.skipped === "push_disabled" ? "🔒" : "⚠️";
    const detail = outcome.pushed
      ? `${outcome.remote}/${outcome.branch}` +
        (outcome.filesChanged > 0 ? ` · ${outcome.filesChanged} 个文件` : "")
      : outcome.message;
    return `${mark} ${outcome.repositoryId}: ${detail}`;
  });
}

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
      // The command wants a taskId, not the run id (TASK-1216 fixes the
      // mismatch that made both buttons unroutable).
      {
        id: REVIEW_ACTIONS.approve,
        label: "Approve",
        style: "primary",
        value: JSON.stringify({ taskId: run.taskId }),
      },
      {
        id: REVIEW_ACTIONS.requestChanges,
        label: "Request Changes",
        style: "danger",
        value: JSON.stringify({ taskId: run.taskId }),
      },
    ],
  });

  return {
    conversationId: options.conversationId ?? run.id,
    text: `${run.id} ready for review`,
    blocks,
  };
}
