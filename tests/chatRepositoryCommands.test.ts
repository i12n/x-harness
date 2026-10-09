import { describe, expect, it } from "vitest";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createRepositoryCommandHandlers } from "../src/command/handlers/repository.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import { COMMAND_SCHEMAS } from "../src/command/schema.js";
import type { Role } from "../src/command/types.js";
import { createRepositoryQueryPort } from "../src/server/deployment/repositoryPort.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";

async function setup(seed = true) {
  const store = new InMemoryRepositoryStore();
  if (seed) {
    await store.createRepository({
      id: "repo-demo",
      name: "demo-app",
      url: "git@github.com:example/demo.git",
      localPath: "/srv/repos/demo",
      verificationCommands: ["node test/verify.js"],
      // TASK-1240: new repositories default to `gitPush: allow`; this fixture
      // keeps one deny so the list card is exercised for both states.
      executionProfile: {
        ...(await defaultExecutionProfile()),
        policy: { ...(await defaultExecutionProfile()).policy, gitPush: "deny" },
      },
    });
    await store.createRepository({
      id: "repo-push",
      name: "pushable",
      url: "git@github.com:example/pushable.git",
      localPath: "/srv/repos/pushable",
      verificationCommands: ["npm test"],
      executionProfile: {
        ...(await store.findRepository("repo-demo")).executionProfile,
        policy: {
          workspaceAccess: "read_write",
          hostFilesystem: "deny",
          gitPush: "allow",
          dockerAccess: "deny",
          productionAccess: "deny",
        },
      },
    });
  }
  const dispatcher = new CommandDispatcher({
    handlers: createRepositoryCommandHandlers({
      repositories: createRepositoryQueryPort({ repositories: store }),
    }),
    idempotency: new InMemoryIdempotencyStore(),
  });
  return { store, dispatcher };
}

async function dispatch(
  dispatcher: CommandDispatcher,
  payload: Record<string, unknown>,
  roles: Role[] = ["guest"],
  type = "repository.list",
) {
  return dispatcher.dispatch(
    {
      id: `cmd-${type}`,
      type,
      version: 1,
      actor: { channel: "feishu", userId: "ou_admin" },
      payload,
      idempotencyKey: `feishu:om-x:${type}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    { channel: "feishu", userId: "ou_admin", roles },
  );
}

describe("chat repository.list", () => {
  it("is readable by every role — it is just metadata", () => {
    expect(COMMAND_SCHEMAS["repository.list"].roles).toEqual([
      "guest",
      "developer",
      "reviewer",
      "admin",
    ]);
  });

  it("answers 「有哪些仓库」 with the registered repositories", async () => {
    const { dispatcher } = await setup();

    const result = await dispatch(dispatcher, {});

    expect(result.status).toBe("succeeded");
    const data = result.data as { repositories: { id: string }[]; message: unknown };
    expect(data.repositories.map((entry) => entry.id)).toEqual(["repo-demo", "repo-push"]);
    const rendered = JSON.stringify(data.message);
    expect(rendered).toContain("demo-app");
    expect(rendered).toContain("pushable");
    expect(rendered).toContain("git@github.com:example/demo.git");
    expect(rendered).toContain("推送 禁止");
    expect(rendered).toContain("推送 允许");
  });

  it("explains how to register one when the list is empty", async () => {
    const { dispatcher } = await setup(false);

    const result = await dispatch(dispatcher, {});

    const rendered = JSON.stringify((result.data as { message: unknown }).message);
    expect(rendered).toContain("还没有注册任何仓库");
    expect(rendered).toContain("ai repository create");
  });
});

describe("chat repository.show", () => {
  it("renders the execution profile of one repository", async () => {
    const { dispatcher } = await setup();

    const result = await dispatch(dispatcher, { repositoryId: "repo-demo" }, ["guest"], "repository.show");

    expect(result.status).toBe("succeeded");
    const rendered = JSON.stringify((result.data as { message: unknown }).message);
    expect(rendered).toContain("/srv/repos/demo");
    expect(rendered).toContain("node test/verify.js");
    expect(rendered).toContain("harness/execution:base");
  });

  it("rejects an unknown repository by name", async () => {
    const { dispatcher } = await setup();

    const result = await dispatch(dispatcher, { repositoryId: "nope" }, ["guest"], "repository.show");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("repository_not_found");
  });
});
