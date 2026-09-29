import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createRepositoryCommandHandlers } from "../src/command/handlers/repository.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import { COMMAND_SCHEMAS } from "../src/command/schema.js";
import type { Role } from "../src/command/types.js";
import { GitService } from "../src/git/gitService.js";
import { RepositoryRegistrationService } from "../src/repository/application/register.js";
import { createRepositoryQueryPort } from "../src/server/deployment/repositoryPort.js";
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

describe("chat repository.create without a configured checkout dir", () => {
  it("rejects and names the missing deployment setting", async () => {
    const { dispatcher } = await setup(false);

    const result = await dispatch(
      dispatcher,
      { url: "git@github.com:i12n/x-music.git" },
      ["admin"],
      "repository.create",
    );

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("registration_unavailable");
  });
});
/** A throwaway bare remote with one commit on `main`. */
function seedOrigin(dir: string, name: string): string {
  const origin = join(dir, `${name}.git`);
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  const seed = join(dir, `${name}-seed`);
  execFileSync("git", ["clone", origin, seed], { stdio: "ignore" });
  writeFileSync(join(seed, "README.md"), `# ${name}\n`);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
  execFileSync("git", ["add", "-A"], { cwd: seed, env });
  execFileSync("git", ["commit", "-m", "init"], { cwd: seed, env });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], {
    cwd: seed,
    env,
    stdio: "ignore",
  });
  return `file://${origin}`;
}

describe("chat repository.create", () => {
  let dir: string;
  let reposDir: string;
  let store: InMemoryRepositoryStore;
  let url: string;
  let dispatcher: CommandDispatcher;
  let counter = 0;

  async function create(payload: Record<string, unknown>, roles: Role[] = ["admin"]) {
    counter += 1;
    return dispatcher.dispatch(
      {
        id: `cmd-create-${counter}`,
        type: "repository.create",
        version: 1,
        actor: { channel: "feishu", userId: "ou_admin" },
        payload,
        idempotencyKey: `feishu:om-${counter}:repository.create`,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { channel: "feishu", userId: "ou_admin", roles },
    );
  }

  beforeEach(async () => {
    counter = 0;
    dir = mkdtempSync(join(tmpdir(), "ai-chat-repo-"));
    reposDir = join(dir, "repos");
    store = new InMemoryRepositoryStore();
    url = seedOrigin(dir, "x-music");
    dispatcher = new CommandDispatcher({
      handlers: createRepositoryCommandHandlers({
        repositories: createRepositoryQueryPort({ repositories: store }),
        registration: new RepositoryRegistrationService({
          repositories: store,
          git: new GitService(),
          reposDir,
        }),
      }),
      idempotency: new InMemoryIdempotencyStore(),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is admin-only — registering clones code onto the host", () => {
    expect(COMMAND_SCHEMAS["repository.create"].roles).toEqual(["admin"]);
  });

  it("clones the checkout and records the repository", async () => {
    const result = await create({ url });

    expect(result.status).toBe("succeeded");
    const data = result.data as {
      created: boolean;
      repository: { id: string; name: string; localPath: string };
      clone: { cloned: boolean; path: string };
      message: unknown;
    };
    expect(data.created).toBe(true);
    expect(data.repository.id).toBe("repo-x-music");
    expect(data.repository.localPath).toBe(join(reposDir, "x-music"));
    expect(data.clone.cloned).toBe(true);
    expect(readFileSync(join(reposDir, "x-music", "README.md"), "utf8")).toContain("# x-music");
    const rendered = JSON.stringify(data.message);
    expect(rendered).toContain("已注册仓库");
    expect(rendered).toContain("repo-x-music");
  });

  it("honours the execution profile fields the deploy doc uses", async () => {
    const result = await create({
      url,
      execImage: "harness/execution:node22",
      verify: "npm test\nnpm run build",
      network: "restricted",
      allow: "registry.npmjs.org\napi.deepseek.com",
      secret: "DEEPSEEK_API_KEY",
      gitPush: "allow",
    });

    const repository = (result.data as { repository: Record<string, unknown> }).repository;
    expect(repository.executionImage).toBe("harness/execution:node22");
    expect(repository.verificationCommands).toEqual(["npm test", "npm run build"]);
    expect(repository.networkMode).toBe("restricted");
    expect(repository.allowedHosts).toEqual(["registry.npmjs.org", "api.deepseek.com"]);
    expect(repository.gitPush).toBe("allow");
  });

  it("treats the same url as already registered instead of cloning twice", async () => {
    await create({ url });

    const again = await create({ url });

    expect(again.status).toBe("succeeded");
    const data = again.data as { created: boolean; clone: unknown; message: unknown };
    expect(data.created).toBe(false);
    expect(data.clone).toBeNull();
    expect(JSON.stringify(data.message)).toContain("仓库已在册");
    expect(await store.listRepositories()).toHaveLength(1);
  });

  it("rejects a developer — registration is not an operator action", async () => {
    const result = await create({ url }, ["developer"]);

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("unauthorized");
    expect(await store.listRepositories()).toHaveLength(0);
  });

  it("refuses a transport git should never be handed from chat", async () => {
    const result = await create({ url: "ftp://example.com/x-music.git" });

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("unsupported_url_scheme");
    expect(await store.listRepositories()).toHaveLength(0);
  });

  it("refuses a name that already belongs to another url", async () => {
    await create({ url });

    const other = seedOrigin(dir, "y-music");
    // Same explicit name → same derived id/path as the checkout above.
    const result = await create({ url: other, name: "x-music" });

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("repository_id_taken");
    expect(await store.listRepositories()).toHaveLength(1);
  });
});
