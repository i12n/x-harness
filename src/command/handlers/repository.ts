import {
  renderRepositoryCreatedMessage,
  renderRepositoryListMessage,
  renderRepositoryMessage,
  repositoryView,
  type RepositoryView,
} from "../../channel/rendering/repository.js";
import type { ExecutionNetworkMode } from "../../domain/executionProfile.js";
import { DuplicateRepositoryError, ValidationError } from "../../errors.js";
import { GitError } from "../../git/gitService.js";
import {
  RepositoryRegistrationError,
  type RepositoryRegistrationService,
} from "../../repository/application/register.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

/**
 * Repository facts for chat. *Asking* what exists is an ordinary question any
 * role may ask; *registering* one clones code onto the host, so it is wired
 * only when the deployment has a checkout directory and is admin-gated by
 * COMMAND_SCHEMAS.
 */
export interface RepositoryQueryPort {
  list(): Promise<RepositoryView[]>;
  show(repositoryId: string): Promise<RepositoryView | undefined>;
}

export function createRepositoryCommandHandlers(deps: {
  repositories: RepositoryQueryPort;
  /**
   * Present only when the deployment has a host directory to clone into.
   * Registration clones code and fixes the execution profile, so it is an
   * admin action (COMMAND_SCHEMAS enforces the role).
   */
  registration?: RepositoryRegistrationService;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "repository.create": async (payload) => {
      if (!deps.registration) {
        throw new CommandRejectionError(
          "registration_unavailable",
          "这个部署没有启用聊天注册仓库（缺少 AI_REPOS_DIR / 仓库目录）",
        );
      }
      try {
        const outcome = await deps.registration.register({
          url: String(payload.url),
          id: optional(payload.id),
          name: optional(payload.name),
          defaultBranch: optional(payload.defaultBranch),
          verificationCommands: splitList(payload.verify),
          executionImage: optional(payload.execImage),
          networkMode: parseNetwork(payload.network),
          allowedHosts: splitList(payload.allow),
          secrets: splitList(payload.secret),
          gitPush: parseGitPush(payload.gitPush),
        });
        const repository = repositoryView(outcome.repository);
        const clone = outcome.clone
          ? {
              path: outcome.clone.path,
              cloned: outcome.clone.cloned,
              message: outcome.clone.message,
            }
          : null;
        return {
          repository,
          created: outcome.created,
          clone,
          message: renderRepositoryCreatedMessage(repository, {
            created: outcome.created,
            clone,
          }),
        };
      } catch (error) {
        if (error instanceof RepositoryRegistrationError || error instanceof GitError) {
          throw new CommandRejectionError(error.code, error.message);
        }
        if (error instanceof DuplicateRepositoryError) {
          throw new CommandRejectionError("duplicate_repository", error.message);
        }
        if (error instanceof ValidationError) {
          throw new CommandRejectionError("invalid_repository", error.message);
        }
        throw error;
      }
    },

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

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One command/entry per line (commas also accepted). */
function splitList(value: unknown): string[] | undefined {
  const text = optional(value);
  if (!text) {
    return undefined;
  }
  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNetwork(value: unknown): ExecutionNetworkMode | undefined {
  const text = optional(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }
  return text === "none" || text === "restricted" ? text : undefined;
}

function parseGitPush(value: unknown): "allow" | "deny" | undefined {
  const text = optional(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }
  return text === "allow" || text === "deny" ? text : undefined;
}
