import { renderReviewMessage } from "../../channel/rendering/review.js";
import type { PublishView } from "../../channel/rendering/review.js";
import { HarnessError } from "../../errors.js";
import type { ReviewService } from "../../review/application/reviewService.js";
import { CommandRejectionError } from "../errors.js";
import type { GitPublishPort } from "./git.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface ReviewHandlerDeps {
  reviews: ReviewService;
  /**
   * Optional: approval is the human boundary, so the remote push happens here.
   * Absent in CLI-only/offline wiring, where the harness never publishes.
   */
  publish?: GitPublishPort;
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
        return { task, publish: await publishSafely(deps.publish, task.id) };
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

/**
 * Approval has already been recorded by the time publishing runs, so a push
 * failure must be reported as an outcome instead of undoing the approval.
 */
async function publishSafely(
  publish: GitPublishPort | undefined,
  taskId: string,
): Promise<PublishView[]> {
  if (!publish) {
    return [];
  }
  try {
    return await publish(taskId);
  } catch (error) {
    return [
      {
        repositoryId: "-",
        branch: "",
        remote: "origin",
        committed: false,
        pushed: false,
        filesChanged: 0,
        skipped: "error",
        message: `发布失败：${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}
