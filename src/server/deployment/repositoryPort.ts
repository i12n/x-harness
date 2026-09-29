import type { RepositoryView } from "../../channel/rendering/repository.js";
import type { RepositoryQueryPort } from "../../command/handlers/repository.js";
import type { Repository } from "../../domain/repository.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";

export function createRepositoryQueryPort(deps: {
  repositories: RepositoryStore;
}): RepositoryQueryPort {
  return {
    async list() {
      const repositories = await deps.repositories.listRepositories();
      return repositories.map(toView);
    },
    async show(repositoryId) {
      try {
        return toView(await deps.repositories.findRepository(repositoryId));
      } catch {
        return undefined;
      }
    },
  };
}

function toView(repository: Repository): RepositoryView {
  const profile = repository.executionProfile;
  return {
    id: repository.id,
    name: repository.name,
    url: repository.url,
    defaultBranch: repository.defaultBranch,
    localPath: repository.localPath,
    verificationCommands: repository.verificationCommands,
    gitPush: profile.policy.gitPush,
    executionImage: profile.image,
    networkMode: profile.network.mode,
    allowedHosts: profile.network.allow,
  };
}
