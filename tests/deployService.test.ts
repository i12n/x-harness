import { describe, expect, it } from "vitest";
import {
  DeployService,
  githubSlug,
  type TestBranchPublisher,
} from "../src/deploy/application/deployService.js";
import type { Repository } from "../src/domain/repository.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import type { GitHubClient, GitHubPullRequest, GitHubWorkflowRun } from "../src/github/githubClient.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { makeId } from "../src/util/id.js";

function repository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-x-music",
    name: "x-music",
    url: "git@github.com:i12n/x-music.git",
    defaultBranch: "main",
    localPath: "/srv/repos/x-music",
    verificationCommands: [],
    executionProfile: defaultExecutionProfile({ name: "default", image: "harness/execution:node22" }),
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

/** A SUCCEEDED run whose workspaces evidence points at a worktree. */
function run() {
  return {
    id: "run-1",
    taskId: "task-1",
    status: "SUCCEEDED",
    result: {
      workspaces: [
        { targetId: "task-1-target-0", path: "/root/ai-workspaces/task-1/run-1/t0" },
      ],
    },
  } as never;
}

function harness(options: { runs?: GitHubWorkflowRun[]; existingPr?: GitHubPullRequest } = {}) {
  const calls: { published: string[]; opened: string[]; merged: number[]; listed: string[] } = {
    published: [],
    opened: [],
    merged: [],
    listed: [],
  };
  const git: TestBranchPublisher = {
    async publish(input) {
      calls.published.push(input.branch);
      return { pushed: true, sha: "abc123" };
    },
  };
  const github: GitHubClient = {
    async findPullRequest() {
      return options.existingPr;
    },
    async openPullRequest(input) {
      calls.opened.push(`${input.head}→${input.base}`);
      return {
        number: 7,
        url: "https://github.com/i12n/x-music/pull/7",
        state: "open",
        merged: false,
        head: input.head,
        base: input.base,
      };
    },
    async mergePullRequest(input) {
      calls.merged.push(input.number);
      return {
        number: input.number,
        url: "https://github.com/i12n/x-music/pull/7",
        state: "closed",
        merged: true,
        head: "test/dlv-1",
        base: "main",
      };
    },
    async listWorkflowRuns(input) {
      calls.listed.push(input.branch);
      return options.runs ?? [];
    },
  };
  const service = new DeployService({
    deliveries: {
      async load(deliveryId) {
        return {
          delivery: { id: deliveryId, specificationId: "spec-1", status: "IN_PROGRESS" } as never,
          tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never],
        };
      },
    },
    repositories: { async findRepository() { return repository(); } },
    runs: { async listRuns() { return [run()]; } },
    git,
    github,
    events: new InMemoryEventStore(),
  });
  return { service, calls };
}

describe("test-branch deploy, GitHub-driven (TASK-1230)", () => {
  it("pushes test/<deliveryId> and opens a PR into the default branch", async () => {
    const { service, calls } = harness();
    const started = await service.deployTest("dlv-1");
    expect(calls.published).toEqual(["test/dlv-1"]);
    expect(calls.opened).toEqual(["test/dlv-1→main"]);
    expect(started.pullRequest.number).toBe(7);
  });

  it("reuses an existing PR instead of opening a second one", async () => {
    const { service, calls } = harness({
      existingPr: {
        number: 3,
        url: "https://github.com/i12n/x-music/pull/3",
        state: "open",
        merged: false,
        head: "test/dlv-1",
        base: "main",
      },
    });
    const started = await service.deployTest("dlv-1");
    expect(calls.opened).toEqual([]);
    expect(started.pullRequest.number).toBe(3);
  });

  it("reports a queued run as pending, and success as succeeded", async () => {
    const pending = harness({
      runs: [
        {
          id: 1,
          name: "deploy-test",
          branch: "test/dlv-1",
          status: "in_progress",
          url: "https://github.com/i12n/x-music/actions/runs/1",
          createdAt: "2026-10-08T00:00:00Z",
        },
      ],
    });
    expect((await pending.service.status("dlv-1")).state).toBe("pending");

    const ok = harness({
      runs: [
        {
          id: 2,
          name: "deploy-test",
          branch: "test/dlv-1",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/i12n/x-music/actions/runs/2",
          createdAt: "2026-10-08T00:00:00Z",
        },
      ],
    });
    expect((await ok.service.status("dlv-1")).state).toBe("succeeded");
  });

  it("reports 'none' until Actions has queued a run", async () => {
    const { service } = harness({ runs: [] });
    expect((await service.status("dlv-1")).state).toBe("none");
  });

  it("merges only when asked, so production deploys after acceptance", async () => {
    const { service, calls } = harness({
      existingPr: {
        number: 9,
        url: "https://github.com/i12n/x-music/pull/9",
        state: "open",
        merged: false,
        head: "test/dlv-1",
        base: "main",
      },
    });
    const outcome = await service.promote("dlv-1");
    expect(calls.merged).toEqual([9]);
    expect(outcome.merged).toBe(true);
  });

  it("reads the GitHub slug from the remote URL", () => {
    expect(githubSlug(repository())).toBe("i12n/x-music");
    expect(githubSlug(repository({ url: "https://github.com/i12n/x-music.git" }))).toBe(
      "i12n/x-music",
    );
    expect(() => githubSlug(repository({ url: "file:///srv/repos/demo-origin.git" }))).toThrow(
      /不是 GitHub/,
    );
  });

  it("fails clearly when there is no pushed work to deploy", async () => {
    const service = new DeployService({
      deliveries: {
        async load(deliveryId) {
          return { delivery: { id: deliveryId } as never, tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never] };
        },
      },
      repositories: { async findRepository() { return repository(); } },
      runs: { async listRuns() { return []; } },
      git: { async publish() { return { pushed: true }; } },
      github: {} as unknown as GitHubClient,
      events: new InMemoryEventStore(),
    });
    await expect(service.deployTest("dlv-1")).rejects.toThrow(/没有带工作区的成功 Run/);
  });

  it("does not open a PR when the repository refuses the push", async () => {
    const { service, calls } = harness();
    const refusing = new DeployService({
      deliveries: {
        async load(deliveryId) {
          return { delivery: { id: deliveryId } as never, tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never] };
        },
      },
      repositories: { async findRepository() { return repository(); } },
      runs: { async listRuns() { return [run()]; } },
      git: { async publish() { return { pushed: false, reason: "gitPush=deny" }; } },
      github: { async findPullRequest() { return undefined; } } as unknown as GitHubClient,
      events: new InMemoryEventStore(),
    });
    await expect(refusing.deployTest("dlv-1")).rejects.toThrow(/gitPush=deny/);
    expect(calls.opened).toEqual([]);
  });
});

describe("ids stay readable", () => {
  it("uses the delivery id verbatim in the branch", () => {
    const { service } = harness();
    expect(service.branchName("dlv-487e422b44")).toBe("test/dlv-487e422b44");
    expect(makeId("x")).toMatch(/^x-/);
  });
});
