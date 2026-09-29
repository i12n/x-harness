import type { PublishView } from "../../channel/rendering/review.js";
import type { CommandHandler, CommandType } from "../types.js";

/** Publishing one task = commit + push its latest succeeded Run's worktrees. */
export type GitPublishPort = (taskId: string) => Promise<PublishView[]>;

/**
 * `git.publish` — the manual/retry path. Approving a Task publishes
 * automatically; this exists because a push can fail on its own (network,
 * remote protection) long after the approval succeeded.
 */
export function createGitCommandHandlers(deps: {
  publish: GitPublishPort;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "git.publish": async (payload) => {
      const outcomes = await deps.publish(String(payload.taskId));
      return { outcomes };
    },
  };
}
