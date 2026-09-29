import type { TaskListEntry } from "../../channel/rendering/taskList.js";
import type { TaskQueryPort } from "../../command/handlers/taskList.js";
import type { TaskStatus } from "../../domain/task.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { TaskStore } from "../../store/taskStore.js";

export function createTaskQueryPort(deps: {
  tasks: TaskStore;
  repositories: RepositoryStore;
}): TaskQueryPort {
  return {
    async list(filter) {
      const tasks = await deps.tasks.listTasks({
        status: filter.status as TaskStatus | undefined,
        repositoryId: filter.repositoryId,
      });
      const names = new Map<string, string>();
      const entries: TaskListEntry[] = [];
      for (const task of tasks) {
        const repositoryId = task.repositoryId;
        if (!names.has(repositoryId)) {
          try {
            names.set(repositoryId, (await deps.repositories.findRepository(repositoryId)).name);
          } catch {
            names.set(repositoryId, repositoryId);
          }
        }
        entries.push({
          id: task.id,
          title: task.title,
          status: task.status,
          repositoryName: names.get(repositoryId) ?? repositoryId,
          updatedAt: task.updatedAt,
        });
      }
      return entries;
    },
  };
}
