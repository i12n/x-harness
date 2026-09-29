import type { MessageBlock, OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

export interface RunListEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  status: string;
  attempt: number;
  finishedAt?: string;
  createdAt: string;
  /** First failing check, when the run failed verification. */
  failureSummary?: string;
}

export interface ProblemListEntry {
  id: string;
  title: string;
  status: string;
  repositoryId?: string;
  /** Number of clarifications still waiting for an answer. */
  openQuestions: number;
  updatedAt: string;
}

export interface DeliveryListEntry {
  id: string;
  specificationId: string;
  title: string;
  status: string;
  requiredTasks: number;
  doneTasks: number;
}

/** "最近发生了什么" — the answer to 「为什么失败了」「跑到哪了」. */
export function renderRunListMessage(
  runs: RunListEntry[],
  options: { conversationId?: string; taskId?: string } = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock(
      "最近运行",
      [`${runs.length} 条${options.taskId ? ` · 任务 ${options.taskId}` : ""}`].join("\n"),
    ),
  ];
  if (runs.length === 0) {
    blocks.push(markdownBlock("还没有运行记录。"));
    return { conversationId: options.conversationId ?? "runs", blocks };
  }
  blocks.push(
    markdownBlock(
      runs
        .map((run) => {
          const lines = [
            `**${run.status}** \`${run.id}\` · ${run.taskId} ${run.taskTitle}`,
            `  尝试 ${run.attempt} · ${run.finishedAt ?? run.createdAt}`,
          ];
          if (run.failureSummary) {
            lines.push(`  ↳ ${run.failureSummary}`);
          }
          return lines.join("\n");
        })
        .join("\n\n"),
    ),
  );
  blocks.push(markdownBlock("看细节：`查看 run-xxx`（含每条验证命令的输出）"));
  return { conversationId: options.conversationId ?? "runs", blocks };
}

export function renderProblemListMessage(
  problems: ProblemListEntry[],
  options: { conversationId?: string; filterNote?: string } = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock(
      "问题",
      [`共 ${problems.length} 个${options.filterNote ? ` · ${options.filterNote}` : ""}`].join(
        "\n",
      ),
    ),
  ];
  if (problems.length === 0) {
    blocks.push(markdownBlock("没有符合条件的问题。"));
    return { conversationId: options.conversationId ?? "problems", blocks };
  }
  blocks.push(
    markdownBlock(
      problems
        .map(
          (problem) =>
            `**${problem.status}** \`${problem.id}\` ${problem.title}` +
            (problem.openQuestions > 0 ? ` · 待回答 ${problem.openQuestions} 个问题` : ""),
        )
        .join("\n"),
    ),
  );
  blocks.push(
    markdownBlock("待回答的问题可以直接回答；确认理解说 `确认`，我再去推导规格与任务。"),
  );
  return { conversationId: options.conversationId ?? "problems", blocks };
}

export function renderDeliveryListMessage(
  deliveries: DeliveryListEntry[],
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock("交付", `${deliveries.length} 个`),
  ];
  if (deliveries.length === 0) {
    blocks.push(markdownBlock("还没有交付记录（规格拆解任务时会自动创建）。"));
    return { conversationId: options.conversationId ?? "deliveries", blocks };
  }
  blocks.push(
    markdownBlock(
      deliveries
        .map(
          (delivery) =>
            `**${delivery.status}** \`${delivery.id}\` ${delivery.title}\n` +
            `  ${delivery.doneTasks}/${delivery.requiredTasks} 个必需任务完成`,
        )
        .join("\n"),
    ),
  );
  blocks.push(markdownBlock("看细节：`查看交付 dlv-xxx`"));
  return { conversationId: options.conversationId ?? "deliveries", blocks };
}
