import { repositoryView } from "../../channel/rendering/repository.js";
import type { RepositoryQueryPort } from "../../command/handlers/repository.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";

export function createRepositoryQueryPort(deps: {
  repositories: RepositoryStore;
}): RepositoryQueryPort {
  return {
    async list() {
      const repositories = await deps.repositories.listRepositories();
      return repositories.map(repositoryView);
    },
    async show(repositoryId) {
      try {
        return repositoryView(await deps.repositories.findRepository(repositoryId));
      } catch {
        return undefined;
      }
    },
  };
}
