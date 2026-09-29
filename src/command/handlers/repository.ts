import {
  renderRepositoryListMessage,
  renderRepositoryMessage,
  type RepositoryView,
} from "../../channel/rendering/repository.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

/**
 * Read-only repository facts for chat. Registration stays a CLI/ops action
 * (it clones code and fixes an execution profile), but *asking* what exists is
 * an ordinary question an operator should be able to ask in the same place.
 */
export interface RepositoryQueryPort {
  list(): Promise<RepositoryView[]>;
  show(repositoryId: string): Promise<RepositoryView | undefined>;
}

export function createRepositoryCommandHandlers(deps: {
  repositories: RepositoryQueryPort;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "repository.list": async () => {
      const repositories = await deps.repositories.list();
      return {
        repositories,
        message: renderRepositoryListMessage(repositories),
      };
    },

    "repository.show": async (payload) => {
      const repositoryId = String(payload.repositoryId).trim();
      const repository = await deps.repositories.show(repositoryId);
      if (!repository) {
        throw new CommandRejectionError(
          "repository_not_found",
          `没有注册名为 ${repositoryId} 的仓库`,
        );
      }
      return {
        repository,
        message: renderRepositoryMessage(repository),
      };
    },
  };
}
