import type { Run } from "../../domain/run.js";
import { describeReviewerReport, parseReviewerReport } from "../../reviewer/domain/verdict.js";
import type { MessageAction, OutgoingMessage } from "../message.js";
import { SECTION, checkStatusLabel, runStatusLabel, targetRoleLabel } from "./copy.js";
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
  /**
   * TASK-1264: what happens next and what the user must do. The caller knows
   * facts the Run does not (the task's status after review, the requirement's
   * stage), so it may supply this; when it does not, the renderer derives a
   * conservative sentence from the Run's own verdict so no card is a dead end.
   */
  nextStep?: RunNextStep;
}

/** 接下来会发生什么 + 需要你做什么（没有人要做的事就写"不用你操作"）。 */
export interface RunNextStep {
  /** Automatic follow-up (retry, next task, deploy watch…). */
  automatic?: string;
  /** What the human owes; defaults to 不用你操作. */
  yours?: string;
  /** Buttons for the decision, when there is one. */
  actions?: MessageAction[];
}

/** TASK-1105: Run facts → OutgoingMessage. Never decides retry/approval. */
export function renderRunMessage(
  run: Run,
  options: RunRenderOptions = {},
): OutgoingMessage {
  const maxOutput = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const blocks = [sectionBlock(run.id, `${SECTION.status}：${runStatusLabel(run.status)}`)];

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
  // TASK-1264: say what is next before the evidence, so the user never has to
  // scroll to the bottom to learn whether they are needed.
  const nextStep = options.nextStep ?? defaultNextStep(run);
  if (nextStep) {
    const lines: string[] = [];
    if (nextStep.automatic) {
      lines.push(`- 会自动：${nextStep.automatic}`);
    }
    lines.push(`- 需要你：${nextStep.yours ?? "不用你操作"}`);
    blocks.push(markdownBlock(`**${SECTION.nextStep}**\n${lines.join("\n")}`));
    if (nextStep.actions && nextStep.actions.length > 0) {
      blocks.push({ type: "actions", actions: nextStep.actions });
    }
  }

  // TASK-1221: the reviewer's structured verdict, when one was produced.
  const review = parseReviewerReport(result?.review);
  if (review) {
    blocks.push(markdownBlock(`**${SECTION.review}**\n${describeReviewerReport(review)}`));
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
        `**${SECTION.acceptance}**\n${lines.join("\n")}` +
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
      blocks.push(markdownBlock(`**${SECTION.workspaces}**\n${lines.join("\n")}`));
    }
  }

  const targets = collectRunTargets(run);
  if (targets.length === 0) {
    blocks.push(markdownBlock("（没有记录目标仓库详情）"));
  } else {
    for (const target of targets) {
      blocks.push(sectionBlock(targetTitle(target), targetDetails(target, maxOutput)));
    }
  }

  return {
    conversationId: options.conversationId ?? run.id,
    text: `${run.id} ${runStatusLabel(run.status)}`,
    blocks,
  };
}

/**
 * TASK-1264: the fallback when the caller has no richer view. Deliberately
 * conservative — it only claims what the Run itself proves.
 */
function defaultNextStep(run: Run): RunNextStep | undefined {
  if (run.status === "FAILED" || run.status === "TIMED_OUT") {
    return {
      automatic: "按失败原因自动重跑一轮",
      yours: "不用你操作；连续失败我会停下来问你。",
    };
  }
  if (run.status !== "SUCCEEDED") {
    return undefined;
  }
  const review = parseReviewerReport(asRecord(run.result)?.review);
  if (review?.verdict === "request_changes") {
    return {
      automatic: `按评审意见自动重跑一轮（第 ${run.attempt + 1} 轮）`,
      yours: "不用你操作，这一轮结果我会发在这里。",
    };
  }
  if (review?.verdict === "needs_human") {
    return {
      automatic: "改动已完成，但评审无法自动判定",
      yours: "需要你看一眼下面的改动再决定。",
    };
  }
  return {
    automatic: "这一轮已完成，进入下一步",
    yours: "不用你操作。",
  };
}

/**
 * TASK-1108: cancellation is a *request*, not a fact — the message must not
 * claim the run is cancelled while the status is still RUNNING.
 */
export function renderRunCancelMessage(run: Run): OutgoingMessage {
  return {
    conversationId: run.id,
    text: `${run.id} 已请求取消。`,
    blocks: [
      sectionBlock(
        run.id,
        `已请求取消。当前${SECTION.status}：${runStatusLabel(run.status)}` +
          "（worker 处理这个请求之前，状态不会变）。",
      ),
    ],
  };
}

function targetTitle(target: RenderedTarget): string {
  return `${statusMark(target.passed)} ${target.repository ?? target.repositoryId} (${targetRoleLabel(
    target.role,
  )})`;
}

function targetDetails(target: RenderedTarget, maxOutput: number): string {
  const lines: string[] = [];
  if (target.workdir) {
    lines.push(`工作目录：${target.workdir}`);
  }
  lines.push(`${SECTION.verification}：${target.passed ? "通过" : "未通过"}`);
  if (target.error) {
    lines.push(`错误：${target.error}`);
  }
  for (const check of target.checks) {
    const exit =
      check.exitCode === undefined || check.exitCode === null
        ? ""
        : ` (exit ${check.exitCode})`;
    lines.push(`检查：${check.command} → ${checkStatusLabel(check.status)}${exit}`);
    if (check.status !== "passed" && check.output) {
      lines.push(`输出：${truncateOutput(check.output, maxOutput)}`);
    }
  }
  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
