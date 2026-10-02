import type { Run } from "../../domain/run.js";
import { describeReviewerReport, parseReviewerReport } from "../../reviewer/domain/verdict.js";
import type { OutgoingMessage } from "../message.js";
import {
  MAX_OUTPUT_CHARS,
  collectRunTargets,
  markdownBlock,
  sectionBlock,
  statusMark,
  truncateOutput,
  type RenderedTarget,
} from "./common.js";
import type { RenderOptions } from "./task.js";

export interface RunRenderOptions extends RenderOptions {
  maxOutputChars?: number;
}

/** TASK-1105: Run facts → OutgoingMessage. Never decides retry/approval. */
export function renderRunMessage(
  run: Run,
  options: RunRenderOptions = {},
): OutgoingMessage {
  const maxOutput = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const blocks = [sectionBlock(run.id, `Status: ${run.status}`)];

  // TASK-1218: the agent's own exit code decides nothing (verification does),
  // but hiding it made a failed agent look like a failed verification — the
  // first cause was invisible on the card.
  if (typeof run.exitCode === "number" && run.exitCode !== 0) {
    blocks.push(
      markdownBlock(
        `**Agent**\n\`${run.agent}\` 以退出码 ${run.exitCode} 结束 —— agent 自身先失败，` +
          "下面的验证结果通常只是后果，不是原因。",
      ),
    );
  }

  const result = asRecord(run.result);
  // TASK-1221: the reviewer's structured verdict, when one was produced.
  const review = parseReviewerReport(result?.review);
  if (review) {
    blocks.push(markdownBlock(`**Reviewer**\n${describeReviewerReport(review)}`));
  }
  // TASK-1220: what the run proved about the criteria it promised, kept
  // separate from "the repository still works".
  const acceptance = asRecord(result?.acceptance);
  const criteria = Array.isArray(acceptance?.criteria) ? acceptance.criteria : [];
  if (criteria.length > 0) {
    const lines = criteria
      .map((entry) => {
        const record = asRecord(entry);
        if (!record) {
          return undefined;
        }
        const mark = record.status === "verified" ? "✓" : "?";
        return `- ${mark} ${String(record.criterion ?? "")}`;
      })
      .filter((line): line is string => Boolean(line));
    const needsHuman = acceptance?.requiresHumanAcceptance === true;
    blocks.push(
      markdownBlock(
        `**Acceptance**\n${lines.join("\n")}` +
          (needsHuman
            ? "\n\n⚠️ 有验收标准没有可执行检查 —— 需要人验收，不能自动通过。"
            : ""),
      ),
    );
  }
  const workspaces = Array.isArray(result?.workspaces) ? result.workspaces : [];
  if (workspaces.length > 0) {
    const lines = workspaces
      .map((entry) => {
        const workspace = asRecord(entry);
        return workspace
          ? `- ${String(workspace.targetId ?? "primary")} · ${String(
              workspace.path ?? "",
            )} (${String(workspace.branch ?? "")})`
          : undefined;
      })
      .filter((line): line is string => Boolean(line));
    if (lines.length > 0) {
      blocks.push(markdownBlock(`**Workspaces**\n${lines.join("\n")}`));
    }
  }

  const targets = collectRunTargets(run);
  if (targets.length === 0) {
    blocks.push(markdownBlock("(no target details recorded)"));
  } else {
    for (const target of targets) {
      blocks.push(sectionBlock(targetTitle(target), targetDetails(target, maxOutput)));
    }
  }

  return {
    conversationId: options.conversationId ?? run.id,
    text: `${run.id} ${run.status}`,
    blocks,
  };
}

/**
 * TASK-1108: cancellation is a *request*, not a fact — the message must not
 * claim the run is cancelled while the status is still RUNNING.
 */
export function renderRunCancelMessage(run: Run): OutgoingMessage {
  return {
    conversationId: run.id,
    text: `${run.id} cancellation requested.`,
    blocks: [
      sectionBlock(
        run.id,
        `Cancellation requested. Status: ${run.status} (unchanged until a worker consumes the request).`,
      ),
    ],
  };
}

function targetTitle(target: RenderedTarget): string {
  return `${statusMark(target.passed)} ${target.repository ?? target.repositoryId} (${
    target.role ?? "supporting"
  })`;
}

function targetDetails(target: RenderedTarget, maxOutput: number): string {
  const lines: string[] = [];
  if (target.workdir) {
    lines.push(`workdir: ${target.workdir}`);
  }
  lines.push(`Verification: ${target.passed ? "PASS" : "FAIL"}`);
  if (target.error) {
    lines.push(`error: ${target.error}`);
  }
  for (const check of target.checks) {
    const exit =
      check.exitCode === undefined || check.exitCode === null
        ? ""
        : ` (exit ${check.exitCode})`;
    lines.push(`check: ${check.command} → ${check.status}${exit}`);
    if (check.status !== "passed" && check.output) {
      lines.push(`output: ${truncateOutput(check.output, maxOutput)}`);
    }
  }
  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
