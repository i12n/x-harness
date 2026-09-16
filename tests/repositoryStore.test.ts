import { describe, expect, it } from "vitest";
import {
  DuplicateRepositoryError,
  RepositoryNotFoundError,
  ValidationError,
} from "../src/errors.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";

const VALID_URL = "git@github.com:example/my-app.git";

describe("InMemoryRepositoryStore", () => {
  it("creates a repository with sensible defaults", async () => {
    const store = new InMemoryRepositoryStore();
    const repo = await store.createRepository({ name: "my-app", url: VALID_URL });

    expect(repo.id).toMatch(/^repo-/);
    expect(repo.name).toBe("my-app");
    expect(repo.url).toBe(VALID_URL);
    expect(repo.defaultBranch).toBe("main");
    expect(repo.localPath).toMatch(/ai-repos\/my-app$/);
    expect(repo.verificationCommands).toEqual([]);
    expect(repo.executionProfile.name).toBe("default");
    expect(repo.executionProfile.network.mode).toBe("none");
    expect(repo.executionProfile.policy.gitPush).toBe("deny");
    expect(repo.createdAt).toBe(repo.updatedAt);
  });

  it("stores a custom execution profile", async () => {
    const store = new InMemoryRepositoryStore();
    const executionProfile = buildExecutionProfile({
      name: "frontend-node",
      image: "harness/node:22",
      network: { mode: "restricted", allow: ["registry.npmjs.org"] },
      resources: { cpus: 4, memoryMb: 4096 },
      secrets: ["GITHUB_TOKEN"],
    });
    const repo = await store.createRepository({
      name: "my-app",
      url: VALID_URL,
      executionProfile,
    });

    expect(repo.executionProfile).toEqual(executionProfile);
  });

  it("registers multiple different repositories", async () => {
    const store = new InMemoryRepositoryStore();
    await store.createRepository({
      name: "my-app",
      url: "git@github.com:example/my-app.git",
      verificationCommands: ["npm run lint", "npm test", "npm run build"],
    });
    await store.createRepository({
      name: "payment-service",
      url: "https://github.com/example/payment-service.git",
      verificationCommands: ["./gradlew test"],
    });

    const repos = await store.listRepositories();
    expect(repos).toHaveLength(2);
    expect(repos.map((repo) => repo.name).sort()).toEqual([
      "my-app",
      "payment-service",
    ]);
  });

  it("honors explicit id, branch, path and verification commands", async () => {
    const store = new InMemoryRepositoryStore();
    const repo = await store.createRepository({
      id: "repo-002",
      name: "payment-service",
      url: "https://github.com/example/payment-service.git",
      defaultBranch: "develop",
      localPath: "/tmp/repos/payment-service",
      verificationCommands: ["./gradlew test", "./gradlew build"],
    });

    expect(repo.id).toBe("repo-002");
    expect(repo.defaultBranch).toBe("develop");
    expect(repo.localPath).toBe("/tmp/repos/payment-service");
    expect(repo.verificationCommands).toEqual(["./gradlew test", "./gradlew build"]);
  });

  it("finds a repository by id and throws when missing", async () => {
    const store = new InMemoryRepositoryStore();
    const created = await store.createRepository({ name: "my-app", url: VALID_URL });

    await expect(store.findRepository(created.id)).resolves.toEqual(created);
    await expect(store.findRepository("repo-missing")).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
  });

  it("rejects duplicate repository ids", async () => {
    const store = new InMemoryRepositoryStore();
    await store.createRepository({ id: "repo-001", name: "first", url: VALID_URL });

    await expect(
      store.createRepository({ id: "repo-001", name: "second", url: VALID_URL }),
    ).rejects.toBeInstanceOf(DuplicateRepositoryError);
  });

  it("rejects invalid urls", async () => {
    const store = new InMemoryRepositoryStore();
    await expect(
      store.createRepository({ name: "my-app", url: "not a url" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a missing name", async () => {
    const store = new InMemoryRepositoryStore();
    await expect(
      store.createRepository({ name: "   ", url: VALID_URL }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
