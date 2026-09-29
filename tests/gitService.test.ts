import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRepository, type Repository } from "../src/domain/repository.js";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import { GitService } from "../src/git/gitService.js";
import { GitPublishService } from "../src/git/publishService.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

let dir: string;
let origin: string;
let base: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
}

function makeRepository(overrides: { gitPush?: "allow" | "deny" } = {}): Repository {
  return buildRepository({
    id: "repo-1",
    name: "demo",
    url: "git@github.com:example/demo.git",
    localPath: base,
    verificationCommands: ["true"],
    executionProfile: buildExecutionProfile({
      name: "default",
      image: "harness/execution:node22",
      policy: { gitPush: overrides.gitPush ?? "allow" },
    }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-git-"));
  origin = join(dir, "origin.git");
  base = join(dir, "base");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  git(["init", "-b", "main"], dir);
  execFileSync("git", ["clone", origin, base], { stdio: "ignore" });
  writeFileSync(join(base, "app.txt"), "one\n");
  git(["add", "-A"], base);
  git(["commit", "-m", "init"], base);
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: base, stdio: "ignore" });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function worktree(branch: string): string {
  const path = join(dir, `wt-${branch.replaceAll("/", "-")}`);
  git(["worktree", "add", path, "-b", branch], base);
  return path;
}

describe("GitService.publishWorkspace", () => {
  it("trusts the workspace directory even when its owner differs", async () => {
    // The harness runs as root while Run containers write as uid 1000, which
    // trips git's "dubious ownership" guard unless safe.directory is set.
    const workspace = worktree("ai/task-owner-run-1");
    writeFileSync(join(workspace, "app.txt"), "owned elsewhere\n");
    const service = new GitService();

    const outcome = await service.publishWorkspace({
      repository: makeRepository(),
      workspacePath: workspace,
      message: "owner mismatch",
    });

    expect(outcome.pushed).toBe(true);
    expect(outcome.skipped).toBeUndefined();
  });

  it("commits the agent's changes and pushes the ai/ branch", async () => {
    const workspace = worktree("ai/task-1-run-1");
    writeFileSync(join(workspace, "app.txt"), "one\ntwo\n");

    const outcome = await new GitService({
      authorName: "Buddy",
      authorEmail: "buddy@example.com",
    }).publishWorkspace({
      repository: makeRepository(),
      workspacePath: workspace,
      message: "implement two",
    });

    expect(outcome.pushed).toBe(true);
    expect(outcome.committed).toBe(true);
    expect(outcome.filesChanged).toBe(1);
    expect(outcome.branch).toBe("ai/task-1-run-1");
    expect(outcome.commit).toMatch(/^[0-9a-f]{40}$/);

    // The remote really has it, with the configured author and message.
    const sha = git(["--git-dir", origin, "rev-parse", "ai/task-1-run-1"]).trim();
    expect(sha).toBe(outcome.commit);
    const author = git(
      ["--git-dir", origin, "log", "-1", "--format=%an <%ae>", "ai/task-1-run-1"],
      dir,
    );
    expect(author.trim()).toBe("Buddy <buddy@example.com>");
    const subject = git(
      ["--git-dir", origin, "log", "-1", "--format=%s", "ai/task-1-run-1"],
      dir,
    );
    expect(subject.trim()).toBe("implement two");
  });

  it("refuses to push unless the repository profile allows it", async () => {
    const workspace = worktree("ai/task-1-run-1");
    writeFileSync(join(workspace, "app.txt"), "changed\n");

    const outcome = await new GitService().publishWorkspace({
      repository: makeRepository({ gitPush: "deny" }),
      workspacePath: workspace,
      message: "nope",
    });

    expect(outcome.skipped).toBe("push_disabled");
    expect(outcome.pushed).toBe(false);
    expect(outcome.committed).toBe(false);
    // Nothing was committed either: the worktree is still dirty.
    expect(git(["status", "--porcelain"], workspace).trim()).not.toBe("");
    expect(git(["--git-dir", origin, "branch", "--list", "ai/task-1-run-1"]).trim()).toBe("");
  });

  it("only pushes branches under the configured prefix", async () => {
    const workspace = worktree("feature/handwritten");
    writeFileSync(join(workspace, "app.txt"), "changed\n");

    const outcome = await new GitService().publishWorkspace({
      repository: makeRepository(),
      workspacePath: workspace,
      message: "nope",
    });

    expect(outcome.skipped).toBe("branch_prefix_not_allowed");
    expect(git(["--git-dir", origin, "branch", "--list", "feature/handwritten"]).trim()).toBe("");
  });

  it("never pushes the default branch", async () => {
    const outcome = await new GitService().publishWorkspace({
      repository: makeRepository(),
      workspacePath: base,
      message: "nope",
    });

    expect(outcome.skipped).toBe("protected_branch");
  });

  it("reports nothing to publish for an untouched worktree", async () => {
    const workspace = worktree("ai/task-1-run-1");
    const outcome = await new GitService().publishWorkspace({
      repository: makeRepository(),
      workspacePath: workspace,
      message: "noop",
    });
    expect(outcome.skipped).toBe("nothing_to_publish");
  });
});

describe("GitService.syncRepository", () => {
  function cloneElsewhere(): string {
    const other = join(dir, "other");
    execFileSync("git", ["clone", origin, other], { stdio: "ignore" });
    return other;
  }

  it("fast-forwards the base checkout", async () => {
    const other = cloneElsewhere();
    writeFileSync(join(other, "new.txt"), "x\n");
    git(["add", "-A"], other);
    git(["commit", "-m", "upstream change"], other);
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other, stdio: "ignore" });

    const outcome = await new GitService().syncRepository(makeRepository());

    expect(outcome.updated).toBe(true);
    expect(outcome.previousHead).not.toBe(outcome.head);
    expect(git(["rev-parse", "HEAD"], base).trim()).toBe(outcome.head);
  });

  it("refuses to touch a dirty base checkout", async () => {
    writeFileSync(join(base, "app.txt"), "local edit\n");
    const outcome = await new GitService().syncRepository(makeRepository());
    expect(outcome.skipped).toBe("dirty_worktree");
  });

  it("reports a missing remote instead of failing", async () => {
    const local = buildRepository({
      id: "repo-2",
      name: "local-only",
      url: "git@github.com:example/local.git",
      localPath: dir,
    });
    const outcome = await new GitService().syncRepository(local);
    expect(outcome.skipped).toBe("no_remote");
  });
});

describe("GitPublishService", () => {
  it("publishes the worktrees of the latest succeeded run", async () => {
    const workspace = worktree("ai/task-9-run-9");
    writeFileSync(join(workspace, "app.txt"), "one\ntwo\n");

    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const repository = makeRepository();
    await repositories.createRepository({
      id: repository.id,
      name: repository.name,
      url: repository.url,
      localPath: repository.localPath,
      verificationCommands: repository.verificationCommands,
      executionProfile: repository.executionProfile,
    });
    const task = await tasks.createTask({
      id: "task-9",
      repositoryId: repository.id,
      title: "Add two",
      status: "REVIEW",
    });
    const run = await runs.createRun({
      id: "run-9",
      taskId: task.id,
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await runs.completeRun(run.id, {
      status: "SUCCEEDED",
      result: { workspaces: [{ targetId: task.targets[0]!.id, path: workspace, branch: "ai/task-9-run-9" }] },
    });

    const service = new GitPublishService({
      tasks,
      runs,
      repositories,
      git: new GitService(),
      events,
    });

    const outcomes = await service.publishTask(task.id);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.pushed).toBe(true);
    expect(git(["--git-dir", origin, "branch", "--list", "ai/task-9-run-9"]).trim()).not.toBe("");
    const audited = await events.listEvents({ type: "git.published" });
    expect(audited).toHaveLength(1);
  });

  it("refuses to publish a task whose run did not succeed", async () => {
    const repositories = new InMemoryRepositoryStore();
    const tasks = new InMemoryTaskStore();
    const runs = new InMemoryRunStore();
    const repository = makeRepository();
    await repositories.createRepository({
      id: repository.id,
      name: repository.name,
      url: repository.url,
      localPath: repository.localPath,
    });
    const task = await tasks.createTask({
      id: "task-9",
      repositoryId: repository.id,
      title: "Broken",
      status: "READY",
    });

    const service = new GitPublishService({
      tasks,
      runs,
      repositories,
      git: new GitService(),
    });

    const outcomes = await service.publishTask(task.id);
    expect(outcomes[0]!.skipped).toBe("no_workspace");
    expect(outcomes[0]!.pushed).toBe(false);
  });
});

describe("GitService.cloneRepository", () => {
  it("clones a fresh checkout from the remote", async () => {
    const dest = join(dir, "checkouts", "x-music");

    const outcome = await new GitService().cloneRepository({
      url: `file://${origin}`,
      path: dest,
    });

    expect(outcome.cloned).toBe(true);
    expect(outcome.path).toBe(dest);
    expect(outcome.branch).toBe("main");
    expect(outcome.head).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(dest, "app.txt"))).toBe(true);
    expect(git(["remote", "get-url", "origin"], dest).trim()).toBe(`file://${origin}`);
  });

  it("is idempotent: an existing checkout of the same origin is kept", async () => {
    const dest = join(dir, "again");
    const service = new GitService();
    await service.cloneRepository({ url: `file://${origin}`, path: dest });
    const head = git(["rev-parse", "HEAD"], dest).trim();

    const outcome = await service.cloneRepository({ url: `file://${origin}`, path: dest });

    expect(outcome.cloned).toBe(false);
    expect(outcome.head).toBe(head);
  });

  it("refuses a path that already holds a different origin", async () => {
    const other = join(dir, "other.git");
    execFileSync("git", ["init", "--bare", "-b", "main", other]);
    const dest = join(dir, "taken");
    await new GitService().cloneRepository({ url: `file://${origin}`, path: dest });

    await expect(
      new GitService().cloneRepository({ url: `file://${other}`, path: dest }),
    ).rejects.toThrow(/origin/);
  });

  it("refuses to clone into a non-empty non-repository directory", async () => {
    const dest = join(dir, "dirty");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "keep.txt"), "mine\n");

    await expect(
      new GitService().cloneRepository({ url: `file://${origin}`, path: dest }),
    ).rejects.toThrow(/拒绝覆盖/);
    expect(existsSync(join(dest, "keep.txt"))).toBe(true);
  });
});
