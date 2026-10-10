import type { Task } from "../../domain/task.js";
import type { FailureEvidence } from "../../domain/failureEvidence.js";
import type { OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";
import { SECTION, targetRoleLabel, taskStatusLabel } from "./copy.js";

/** Dependency facts a renderer may display (never queried from a store here). */
export interface TaskDependencyFacts {
  runnable: boolean;
  waiting?: boolean;
  dependencyBlocked?: boolean;
  prerequisites: { id: string; title?: string; status: string }[];
  /** Failed ancestors keeping this task from running (TASK-1207). */
  blockingTaskIds?: string[];
  blockingChain?: {
    taskId: string;
    title?: string;
    status?: string;
    note?: string;
  }[];
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
  /** Latest failure evidence of the task's most recent run (TASK-1207). */
  latestFailure?: FailureEvidence;
  /** Owner of `latestFailure` when it comes from the blocking task. */
  latestFailureTaskId?: string;
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
        `**${SECTION.dependencies}**\n${options.dependency.prerequisites
          .map(
            (prerequisite) =>
              `- ${prerequisite.status === "DONE" ? "✓" : "⏳"} ${prerequisite.id}` +
              (prerequisite.title ? ` ${prerequisite.title}` : "") +
              `（${taskStatusLabel(prerequisite.status)}）`,
          )
          .join("\n")}`,
      ),
    );
  }
  if (options.dependency?.blockingTaskIds?.length) {
    blocks.push(
      markdownBlock(
        `**${SECTION.blockedBy}**\n${options.dependency.blockingTaskIds
          .map((id) => {
            const entry = options.dependency?.blockingChain?.find(
              (chainEntry) => chainEntry.taskId === id,
            );
            return `- ${id}${
              entry?.status ? ` —— ${taskStatusLabel(entry.status)}` : ""
            }`;
          })
          .join("\n")}`,
      ),
    );
  }
  if (options.dependency?.blockingChain && options.dependency.blockingChain.length > 1) {
    blocks.push(
      markdownBlock(
        `**${SECTION.blockingChain}**\n${options.dependency.blockingChain
          .map(
            (entry) =>
              `${entry.taskId}${entry.title ? ` ${entry.title}` : ""}` +
              (entry.status ? `（${taskStatusLabel(entry.status)}）` : ""),
          )
          .join("\n  ↓\n")}`,
      ),
    );
  }
  if (options.latestFailure) {
    const source =
      options.latestFailureTaskId && options.latestFailureTaskId !== task.id
        ? `${options.latestFailureTaskId}: `
        : "";
    blocks.push(
      markdownBlock(
        `**${SECTION.latestFailure}**\n${source}${formatFailure(options.latestFailure)}`,
      ),
    );
  }
  const targets =
    task.targets.length > 0
      ? task.targets
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
  if (task.acceptance.length > 0) {
    blocks.push(
      markdownBlock(
        `**${SECTION.acceptance}**\n${task.acceptance
          .map((item) => `- ${item}`)
          .join("\n")}`,
      ),
    );
  }
  if (task.description) {
    blocks.push(sectionBlock(SECTION.description, task.description));
  }

  return {
    conversationId: options.conversationId ?? task.id,
    text: `${task.id} ${task.title}（${taskStatusLabel(task.status)}）`,
    blocks,
  };
}

function renderHeader(task: Task, dependency?: TaskDependencyFacts): string {
  const lines = [`${SECTION.status}：${taskStatusLabel(task.status)}`];
  if (dependency) {
    lines.push(`可运行：${dependency.runnable ? "是" : "否"}`);
    if (dependency.dependencyBlocked) {
      lines.push("依赖阻塞：是");
    }
  }
  return lines.join("\n");
}

/** Facts only: command/exit code/message plus already-truncated output. */
export function formatFailure(evidence: FailureEvidence): string {
  if (evidence.kind === "verification") {
    const parts = [`验证未通过：${evidence.command ?? "（未知命令）"}`];
    if (evidence.exitCode !== undefined && evidence.exitCode !== null) {
      parts.push(`退出码 ${evidence.exitCode}`);
    }
    return parts.join(" · ") + (evidence.output ? `\n${evidence.output}` : "");
  }
  const label = evidence.kind === "unknown" ? SECTION.failure : evidence.kind;
  return `${label}：${evidence.message ?? "（没有详情）"}`;
}
