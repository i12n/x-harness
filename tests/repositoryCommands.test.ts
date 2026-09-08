import { describe, expect, it } from "vitest";
import {
  createRepositoryCommand,
  listRepositoriesCommand,
  showRepositoryCommand,
} from "../src/cli/commands/repositoryCommands.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";

const VALID_URL = "git@github.com:example/my-app.git";

describe("repository CLI commands", () => {
  it("create returns a repository built from CLI options", async () => {
    const store = new InMemoryRepositoryStore();
    const repo = await createRepositoryCommand(store, {
      id: "repo-001",
      name: "my-app",
      url: VALID_URL,
      defaultBranch: "develop",
      localPath: "/tmp/repos/my-app",
      verify: ["npm test", "npm run build", "npm test"],
    });

    expect(repo.id).toBe("repo-001");
    expect(repo.defaultBranch).toBe("develop");
    expect(repo.verificationCommands).toEqual(["npm test", "npm run build"]);
  });

  it("list returns every created repository", async () => {
    const store = new InMemoryRepositoryStore();
    await createRepositoryCommand(store, { id: "repo-001", name: "my-app", url: VALID_URL });
    await createRepositoryCommand(store, {
      id: "repo-002",
      name: "payment-service",
      url: "https://github.com/example/payment-service.git",
    });

    const repos = await listRepositoriesCommand(store);
    expect(repos.map((repo) => repo.id)).toEqual(["repo-001", "repo-002"]);
  });

  it("show returns the requested repository", async () => {
    const store = new InMemoryRepositoryStore();
    await createRepositoryCommand(store, { id: "repo-001", name: "my-app", url: VALID_URL });

    const repo = await showRepositoryCommand(store, "repo-001");
    expect(repo.name).toBe("my-app");
  });
});
