import type { Clarification, Problem } from "../../domain/problem.js";
import type { MessageBlock, OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";
import { SECTION, problemStatusLabel } from "./copy.js";
import type { RenderOptions } from "./task.js";

export interface ProblemRenderOptions extends RenderOptions {
  needsInput?: boolean;
  clarifications?: Clarification[];
  /**
   * TASK-1266: what the user already confirmed, so the card records it in one
   * line instead of printing questions that no longer need an answer.
   */
  answered?: { question: string; answer: string }[];
}

export const PROBLEM_ANSWER_ACTION = "problem.clarification.answer";
/** TASK-1266: the card's single submit — collects every group at once. */
export const PROBLEM_ANSWER_ALL_ACTION = "problem.clarification.answer_all";

/**
 * TASK-1105/1107: Problem facts + structured clarifications → OutgoingMessage.
 * Options come from Clarification.options; nothing is invented here.
 */
export function renderProblemMessage(
  problem: Problem,
  options: ProblemRenderOptions = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock(
      `${problem.id} · ${problem.title}`,
      `${SECTION.status}：${problemStatusLabel(problem.status)}`,
    ),
    markdownBlock(`**${SECTION.problem}**\n${problem.statement}`),
  ];

  const clarifications = options.clarifications ?? [];
  if (options.needsInput && clarifications.length > 0) {
    blocks.push(
      markdownBlock(
        `**还需要确认（还剩 ${clarifications.length} 项）**`,
      ),
    );
    const answerable: string[] = [];
    for (const clarification of clarifications) {
      if (clarification.options.length === 0) {
        // No choices to tick — this one is answered in words.
        blocks.push(markdownBlock(`✍️ ${clarification.question}（直接回复文字即可）`));
        continue;
      }
      // TASK-1266: one toggle group per question, each carrying its own
      // question text, and *no* per-group submit. The card has a single
      // 「提交全部答案」 button, so a three-question form is answered in one
      // click instead of three submits (which re-posted the whole card).
      blocks.push({
        type: "choice",
        id: clarification.id,
        title: `**${clarification.question}**`,
        options: clarification.options.map((option) => ({
          id: option.id,
          label: option.label,
        })),
        multi: true,
      });
      answerable.push(clarification.id);
    }
    if (answerable.length > 0) {
      blocks.push({
        type: "actions",
        actions: [
          {
            id: PROBLEM_ANSWER_ALL_ACTION,
            label: "提交全部答案",
            style: "primary",
            value: JSON.stringify({ problemId: problem.id }),
          },
        ],
      });
    }
  } else if (problem.status === "CONFIRMED") {
    blocks.push(
      markdownBlock(
        options.answered && options.answered.length > 0
          ? `✅ 需求已确认，我接着去拆规格和任务。\n${answeredLine(options.answered)}`
          : "✅ 需求已确认，我接着去拆规格和任务。",
      ),
    );
  }

  // TASK-1266: answered questions are not printed again — one line records them.
  if (options.answered && options.answered.length > 0 && options.needsInput) {
    blocks.push(markdownBlock(answeredLine(options.answered)));
  }

  return {
    conversationId: options.conversationId ?? problem.id,
    text: `${problem.id} ${problem.title}（${problemStatusLabel(problem.status)}）`,
    blocks,
  };
}

/** TASK-1266: one line instead of re-printing every answered question. */
export function answeredLine(answered: { question: string; answer: string }[]): string {
  const items = answered.map((entry) => `${shorten(entry.question)}=${shorten(entry.answer, 40)}`);
  return `✅ 已确认 ${answered.length} 项：${items.join(" · ")}`;
}

function shorten(text: string, max = 24): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
