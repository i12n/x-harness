import type { ConversationService } from "../../conversation/service.js";
import {
  ProblemConfirmationError,
  type ProblemService,
} from "../../problem/application/service.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface ProblemHandlerDeps {
  problems: ProblemService;
  /** Optional: links the conversation to the created problem. */
  conversations?: ConversationService;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The chosen option's label, else the free-text answer. */
function answerLabel(clarification: {
  options: { id: string; label: string }[];
  answer?: { optionId?: string; text?: string };
}): string {
  const answer = clarification.answer;
  if (!answer) {
    return "";
  }
  if (answer.optionId) {
    return (
      clarification.options.find((option) => option.id === answer.optionId)?.label ??
      answer.optionId
    );
  }
  return answer.text ?? "";
}

function rejectDomainError(error: unknown): never {
  if (error instanceof ProblemConfirmationError) {
    throw new CommandRejectionError(error.code, error.message);
  }
  throw error;
}

/**
 * TASK-1107: composition point where Commands meet the Problem application.
 * The dispatcher stays a pure router; business rules live in ProblemService.
 */
export function createProblemCommandHandlers(
  deps: ProblemHandlerDeps,
): Partial<Record<CommandType, CommandHandler>> {
  return {
    "problem.create": async (payload, command) => {
      const outcome = await deps.problems.create({
        title: String(payload.title),
        statement: String(payload.statement),
        repositoryId: asString(payload.repositoryId),
      });
      if (deps.conversations && command.conversation?.id) {
        try {
          await deps.conversations.attachSubject(command.conversation.id, {
            type: "problem",
            id: outcome.problem.id,
          });
        } catch {
          // Conversation linking is best-effort: the problem itself is the
          // primary side effect and must not be lost because the chat row is
          // missing (e.g. a command injected outside the webhook pipeline).
        }
      }
      return {
        problem: outcome.problem,
        needsInput: outcome.needsInput,
        clarifications: outcome.clarifications,
      };
    },

    "problem.confirm": async (payload) => {
      try {
        const problem = await deps.problems.confirm(String(payload.problemId));
        return { problem };
      } catch (error) {
        rejectDomainError(error);
      }
    },

    "problem.clarification.answer": async (payload) => {
      try {
        const outcome = await deps.problems.answer(
          String(payload.problemId),
          String(payload.clarificationId),
          {
            optionId: asString(payload.optionId),
            optionIds: Array.isArray(payload.optionIds)
              ? payload.optionIds.filter((id): id is string => typeof id === "string")
              : undefined,
            text: asString(payload.text),
            answer: asString(payload.answer),
          },
        );
        // TASK-1266: hand the renderer the one-line record of what is already
        // confirmed, so a re-rendered card never prints answered questions.
        const all = await deps.problems
          .listClarifications(String(payload.problemId))
          .catch(() => []);
        const answered = all
          .filter((clarification) => clarification.status === "ANSWERED")
          .map((clarification) => ({
            question: clarification.question,
            answer: answerLabel(clarification),
          }));
        return {
          problem: outcome.problem,
          needsInput: outcome.needsInput,
          clarifications: outcome.clarifications,
          answered,
        };
      } catch (error) {
        rejectDomainError(error);
      }
    },
  };
}
