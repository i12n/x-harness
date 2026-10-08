import { describe, expect, it } from "vitest";
import { DeployService } from "../src/deploy/application/deployService.js";
import type { GitHubClient, GitHubWorkflowRun } from "../src/github/githubClient.js";
import { defaultExecutionProfile } from "../src/domain/executionProfile.js";
import type { Repository } from "../src/domain/repository.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";

const repository: Repository = {
  id: "repo-x-music",
  name: "x-music",
  url: "git@github.com:i12n/x-music.git",
  defaultBranch: "main",
  localPath: "/srv/repos/x-music",
  verificationCommands: [],
  executionProfile: defaultExecutionProfile({ name: "default", image: "harness/execution:node22" }),
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

function run(status: GitHubWorkflowRun["status"], conclusion?: GitHubWorkflowRun["conclusion"]) {
  return {
    id: 1,
    name: "deploy-test",
    branch: "test/dlv-1",
    status,
    ...(conclusion ? { conclusion } : {}),
    url: "https://github.com/i12n/x-music/actions/runs/1",
    createdAt: "2026-10-08T00:00:00Z",
  } satisfies GitHubWorkflowRun;
}

/** TASK-1231: the watcher, with a mutable run list and a controllable clock. */
function watcher(runs: GitHubWorkflowRun[]) {
  let nowMs = Date.parse("2026-10-08T00:00:00Z");
  let lookups = 0;
  const github = {
    async findPullRequest() {
      return undefined;
    },
    async openPullRequest() {
      throw new Error("unused");
    },
    async mergePullRequest() {
      throw new Error("unused");
    },
    async listWorkflowRuns() {
      lookups += 1;
      return runs;
    },
  } as unknown as GitHubClient;
  const service = new DeployService({
    deliveries: {
      async load(deliveryId) {
        return {
          delivery: { id: deliveryId } as never,
          tasks: [{ id: "task-1", repositoryId: "repo-x-music" } as never],
        };
      },
    },
    repositories: { async findRepository() { return repository; } },
    runs: { async listRuns() { return []; } },
    git: { async publish() { return { pushed: true }; } },
    github,
    events: new InMemoryEventStore(),
    watchIntervalMs: 30_000,
    watchTtlMs: 30 * 60_000,
    now: () => new Date(nowMs),
  });
  return {
    service,
    advance: (ms: number) => {
      nowMs += ms;
    },
    lookups: () => lookups,
    setRuns: (next: GitHubWorkflowRun[]) => {
      runs.length = 0;
      runs.push(...next);
    },
  };
}

describe("deployment watching (TASK-1231)", () => {
  it("reports only changes, and stops after a terminal state", async () => {
    const w = watcher([run("in_progress")]);
    w.service.watch("dlv-1");

    expect(await w.service.poll()).toEqual([
      { deliveryId: "dlv-1", state: "pending", kind: "test", run: run("in_progress"), terminal: false },
    ]);

    w.advance(30_000);
    w.setRuns([run("completed", "success")]);
    const done = await w.service.poll();
    expect(done.map((t) => t.state)).toEqual(["succeeded"]);
    expect(done[0]!.terminal).toBe(true);
    expect(w.service.watched()).toEqual([]);

    // Terminal: no further lookups even if time passes.
    w.advance(60_000);
    expect(await w.service.poll()).toEqual([]);
    expect(w.lookups()).toBe(2);
  });

  it("does not poll before the interval elapses", async () => {
    const w = watcher([run("in_progress")]);
    w.service.watch("dlv-1");
    await w.service.poll(); // first check happens immediately
    w.advance(5_000);
    expect(await w.service.poll()).toEqual([]); // too soon
    expect(w.lookups()).toBe(1);
    w.advance(30_000);
    await w.service.poll();
    expect(w.lookups()).toBe(2);
  });

  it("gives up on a deployment that never finishes", async () => {
    const w = watcher([run("queued")]);
    w.service.watch("dlv-1");
    await w.service.poll();
    w.advance(31 * 60_000);
    const stale = await w.service.poll();
    expect(stale).toEqual([{ deliveryId: "dlv-1", state: "stale", kind: "test", terminal: true }]);
    expect(w.service.watched()).toEqual([]);
  });

  it("keeps watching when a lookup fails", async () => {
    const service = new DeployService({
      deliveries: { async load(id) { return { delivery: { id } as never, tasks: [{ id: "t", repositoryId: "repo-x-music" } as never] }; } },
      repositories: { async findRepository() { return repository; } },
      runs: { async listRuns() { return []; } },
      git: { async publish() { return { pushed: true }; } },
      github: {
        async listWorkflowRuns() {
          throw new Error("network");
        },
      } as unknown as GitHubClient,
      events: new InMemoryEventStore(),
    });
    service.watch("dlv-1");
    expect(await service.poll()).toEqual([]);
    expect(service.watched()).toEqual(["dlv-1"]);
  });
});
