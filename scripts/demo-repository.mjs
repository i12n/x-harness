#!/usr/bin/env node

// Phase 1 acceptance demo (no Postgres needed): registers multiple different
// repositories in one in-memory store, then lists and shows them.
// Requires a build first: npm run build

import {
  createRepositoryCommand,
  listRepositoriesCommand,
  showRepositoryCommand,
} from "../dist/cli/commands/repositoryCommands.js";
import { InMemoryRepositoryStore } from "../dist/store/inMemoryRepositoryStore.js";

const store = new InMemoryRepositoryStore();

const myApp = await createRepositoryCommand(store, {
  name: "my-app",
  url: "git@github.com:example/my-app.git",
  verify: ["npm run lint", "npm test", "npm run build"],
});

const payment = await createRepositoryCommand(store, {
  id: "repo-002",
  name: "payment-service",
  url: "https://github.com/example/payment-service.git",
  defaultBranch: "develop",
  localPath: "/tmp/repos/payment-service",
  verify: ["./gradlew test", "./gradlew build"],
});

console.log(`created: ${myApp.id}, ${payment.id}`);

const repos = await listRepositoriesCommand(store);
console.log(`registered ${repos.length} repositories:`);
for (const repo of repos) {
  console.log(`- ${repo.id}  ${repo.name}  ${repo.url}`);
}

const shown = await showRepositoryCommand(store, "repo-002");
console.log(
  `show repo-002 -> name=${shown.name} branch=${shown.defaultBranch} checks=${shown.verificationCommands.length}`,
);
