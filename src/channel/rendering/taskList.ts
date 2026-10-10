import type { MessageBlock, OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";
import { taskStatusLabel } from "./copy.js";

/** Task facts for the list view (plain data). */
export interface TaskListEntry {
  id: string;
  title: string;
  status: string;
  repositoryName: string;
  updatedAt: string;
}

/** Statuses worth printing in order; unknown ones are appended as-is. */
const STATUS_ORDER = [
  "RUNNING",
  "VERIFYING",
  "REVIEW",
  "READY",
  "QUEUED",
  "INBOX",
  "BLOCKED",
  "DONE",
];

export function renderTaskListMessage(
  tasks: TaskListEntry[],
  options: { conversationId?: string; filterNote?: string } = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock(
      "任务",
      [`共 ${tasks.length} 个${options.filterNote ? ` · ${options.filterNote}` : ""}`].join("\n"),
    ),
  ];

  if (tasks.length === 0) {
    blocks.push(markdownBlock("没有符合条件的任务。"));
    return { conversationId: options.conversationId ?? "tasks", blocks };
  }

  const byStatus = new Map<string, TaskListEntry[]>();
  for (const task of tasks) {
    const list = byStatus.get(task.status) ?? [];
    list.push(task);
    byStatus.set(task.status, list);
  }
  const statuses = [...byStatus.keys()].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  for (const status of statuses) {
    const entries = byStatus.get(status)!;
    blocks.push(
      markdownBlock(
        `**${taskStatusLabel(status)}（${entries.length}）**\n${entries
          .map((task) => `- \`${task.id}\` ${task.title} · ${task.repositoryName}`)
          .join("\n")}`,
      ),
    );
  }
  blocks.push(markdownBlock("说 `运行 <task-id>` 开工，或 `查看 <task-id>` 看细节。"));
  return { conversationId: options.conversationId ?? "tasks", blocks };
}

function rank(status: string): number {
  const index = STATUS_ORDER.indexOf(status);
  return index === -1 ? STATUS_ORDER.length : index;
}
