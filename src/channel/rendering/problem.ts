import type { Clarification, Problem } from "../../domain/problem.js";
import type { MessageBlock, OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";
import type { RenderOptions } from "./task.js";

export interface ProblemRenderOptions extends RenderOptions {
  needsInput?: boolean;
  clarifications?: Clarification[];
}

export const PROBLEM_ANSWER_ACTION = "problem.clarification.answer";

/**
 * TASK-1105/1107: Problem facts + structured clarifications → OutgoingMessage.
 * Options come from Clarification.options; nothing is invented here.
 */
export function renderProblemMessage(
  problem: Problem,
  options: ProblemRenderOptions = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock(`${problem.id} · ${problem.title}`, `Status: ${problem.status}`),
    markdownBlock(`**Problem**\n${problem.statement}`),
  ];

  const clarifications = options.clarifications ?? [];
  if (options.needsInput && clarifications.length > 0) {
    blocks.push(
      markdownBlock(
        `**还需要确认**\n${clarifications
          .map(
            (clarification, index) =>
              `${index + 1}. ${clarification.question}\n` +
              clarification.options
                .map((option) => `   - ${option.label} (${option.id})`)
                .join("\n"),
          )
          .join("\n")}`,
      ),
    );
    for (const clarification of clarifications) {
      if (clarification.options.length === 0) {
        continue;
      }
      blocks.push({
        type: "actions",
        actions: clarification.options.map((option) => ({
          id: PROBLEM_ANSWER_ACTION,
          label: option.label,
          value: JSON.stringify({
            problemId: problem.id,
            clarificationId: clarification.id,
            optionId: option.id,
          }),
        })),
      });
    }
  } else if (problem.status === "CONFIRMED") {
    blocks.push(markdownBlock("✅ 问题已确认（CONFIRMED）"));
  }

  return {
    conversationId: options.conversationId ?? problem.id,
    text: `${problem.id} ${problem.title} (${problem.status})`,
    blocks,
  };
}
