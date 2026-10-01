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
          .map((clarification, index) => `${index + 1}. ${clarification.question}`)
          .join("\n")}`,
      ),
    );
    for (const clarification of clarifications) {
      if (clarification.options.length === 0) {
        continue;
      }
      // TASK-1216: one selectable group per question. Several options can be
      // ticked and submitted together instead of one click per answer.
      blocks.push({
        type: "choice",
        id: clarification.id,
        options: clarification.options.map((option) => ({
          id: option.id,
          label: option.label,
        })),
        multi: true,
        submit: {
          action: PROBLEM_ANSWER_ACTION,
          label: "提交选择",
          payload: { problemId: problem.id, clarificationId: clarification.id },
        },
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
