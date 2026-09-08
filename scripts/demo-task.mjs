#!/usr/bin/env node

// Phase 2 acceptance demo (no Postgres needed): create a repository, bind a
// task to it, run intake validation, list and show.
// Requires a build first: npm run build

import {
  createTaskCommand,
  listTasksCommand,
  showTaskCommand,
  validateTaskCommand,
} from "../dist/cli/commands/taskCommands.js";
import { InMemoryRepositoryStore } from "../dist/store/inMemoryRepositoryStore.js";
import { InMemoryTaskStore } from "../dist/store/inMemoryTaskStore.js";

const repositories = new InMemoryRepositoryStore();
const tasks = new InMemoryTaskStore();

const repo = await repositories.createRepository({
  id: "repo-001",
  name: "my-app",
  url: "git@github.com:example/my-app.git",
  verificationCommands: ["npm run lint", "npm test", "npm run build"],
});
console.log(`repository ready: ${repo.id}`);

const task = await createTaskCommand(tasks, repositories, {
  id: "task-001",
  repo: "repo-001",
  title: "Add user avatar",
  description: "Allow users to upload avatars.",
  accept: ["JPG supported", "PNG supported", "Maximum 5MB", "Tests pass"],
});
console.log(`task created: ${task.id} status=${task.status} repository=${task.repositoryId}`);

const validated = await validateTaskCommand(tasks, repositories, "task-001");
console.log(`task validated: ${validated.task.id} -> ${validated.task.status}`);

const list = await listTasksCommand(tasks, { repositoryId: "repo-001" });
console.log(`tasks for ${repo.id}: ${list.map((item) => item.id).join(", ")}`);

const shown = await showTaskCommand(tasks, "task-001");
console.log(`show task-001 -> title=${shown.title} acceptance=${shown.acceptance.length}`);
