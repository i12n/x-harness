import type { Run } from "../../domain/run.js";
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

  const result = asRecord(run.result);
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
