import { renderReviewMessage } from "../../channel/rendering/review.js";
import { HarnessError } from "../../errors.js";
import type { ReviewService } from "../../review/application/reviewService.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface ReviewHandlerDeps {
  reviews: ReviewService;
}

function rejectDomainError(error: unknown): never {
  if (error instanceof HarnessError) {
    throw new CommandRejectionError("review_not_allowed", error.message);
  }
  throw error;
}

/** TASK-1109: review commands reuse the review application service. */
export function createReviewCommandHandlers(
  deps: ReviewHandlerDeps,
): Partial<Record<CommandType, CommandHandler>> {
  return {
    "review.show": async (payload) => {
      const outcome = await deps.reviews.show(String(payload.taskId));
      return {
        ...outcome,
        message: outcome.latestRun ? renderReviewMessage(outcome.latestRun) : undefined,
      };
    },

    "review.approve": async (payload, command) => {
      try {
        const task = await deps.reviews.approve(String(payload.taskId), {
          channel: command.actor.channel,
          userId: command.actor.userId,
        });
        return { task };
      } catch (error) {
        rejectDomainError(error);
      }
    },

    "review.request_changes": async (payload, command) => {
      try {
        const task = await deps.reviews.requestChanges(
          String(payload.taskId),
          { channel: command.actor.channel, userId: command.actor.userId },
          typeof payload.feedback === "string" ? payload.feedback : undefined,
        );
        return { task };
      } catch (error) {
        rejectDomainError(error);
      }
    },
  };
}
