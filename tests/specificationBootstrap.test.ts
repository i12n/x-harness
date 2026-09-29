import { describe, expect, it } from "vitest";
import type { ChatClient, ChatCompletionRequest } from "../src/llm/chatClient.js";
import { SpecificationBootstrap, normalizeDerived } from "../src/server/specificationBootstrap.js";
import { DeterministicTaskPlanner } from "../src/specification/application/planner.js";
import { PlanningService } from "../src/specification/application/planning.js";
import { SpecificationService } from "../src/specification/application/service.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

class FixedChatClient implements ChatClient {
  readonly model = "test-model";
  requests: ChatCompletionRequest[] = [];
  constructor(private readonly response: string) {}
  async complete(request: ChatCompletionRequest): Promise<string> {
    this.requests.push(request);
    return this.response;
  }
}

async function buildHarness(response: string, options: { confirmed?: boolean } = {}) {
  const problems = new InMemoryProblemStore();
  const repositories = new InMemoryRepositoryStore();
  const specifications = new InMemorySpecificationStore();
  const specificationPlans = new InMemorySpecificationPlanStore();
  const tasks = new InMemoryTaskStore();
  const events = new InMemoryEventStore();

  await repositories.createRepository({
    id: "repo-x",
    name: "x-app",
    url: "git@github.com:example/x-app.git",
    localPath: "/tmp/x-app",
    verificationCommands: ["npm test"],
  });
  const problem = await problems.createProblem({
    id: "prob-1",
    title: "首页空状态",
    statement: "首页在没有数据时没有任何提示",
    repositoryId: "repo-x",
  });
  if (options.confirmed !== false) {
    await problems.setProblemSpec("prob-1", {
      problem: "首页无空状态",
      expected: "显示空状态提示",
    });
    await problems.updateProblemStatus(problem.id, "CONFIRMED");
  }

  const specificationService = new SpecificationService({
    specifications,
    problems,
    events,
  });
  const planning = new PlanningService({
    specifications,
    plans: specificationPlans,
    tasks,
    planner: new DeterministicTaskPlanner(),
    events,
  });
  const chat = new FixedChatClient(response);
  const bootstrap = new SpecificationBootstrap({
    problems,
    repositories,
    specifications,
    specificationPlans,
    tasks,
    specificationService,
    planning,
    chat,
  });
  return { bootstrap, specifications, tasks, chat, problems };
}

const DERIVED = JSON.stringify({
  title: "首页空状态提示",
  summary: "无数据时展示提示",
  requirements: ["无数据时展示空状态", "提示文案可配置"],
  acceptance: ["打开首页且无数据时能看到空状态提示"],
  targets: [{ repositoryId: "repo-x", role: "primary" }],
});

describe("SpecificationBootstrap", () => {
  it("turns a confirmed problem into a plan with tasks", async () => {
    const { bootstrap, tasks } = await buildHarness(DERIVED);

    const outcome = await bootstrap.bootstrap("prob-1");

    expect(outcome?.specification.status).toBe("PLANNED");
    expect(outcome?.specification.acceptance).toEqual([
      "打开首页且无数据时能看到空状态提示",
    ]);
    expect(outcome?.tasks).toHaveLength(2);
    expect(tasks).toBeDefined();
  });

  it("is idempotent: a second call replays the plan without re-asking the model", async () => {
    const { bootstrap, chat } = await buildHarness(DERIVED);

    const first = await bootstrap.bootstrap("prob-1");
    const second = await bootstrap.bootstrap("prob-1");

    expect(second?.specification.id).toBe(first?.specification.id);
    expect(second?.replayed).toBe(true);
    expect(second?.tasks).toHaveLength(first?.tasks.length ?? 0);
    expect(chat.requests).toHaveLength(1);
  });

  it("does nothing for a problem that is not confirmed", async () => {
    const { bootstrap, chat } = await buildHarness(DERIVED, { confirmed: false });

    expect(await bootstrap.bootstrap("prob-1")).toBeUndefined();
    expect(chat.requests).toHaveLength(0);
  });

  it("reports repository ids the deployment does not know", async () => {
    const { bootstrap } = await buildHarness(
      JSON.stringify({
        title: "t",
        summary: "s",
        requirements: ["r"],
        acceptance: ["a"],
        targets: [{ repositoryId: "repo-ghost" }],
      }),
    );

    const outcome = await bootstrap.bootstrap("prob-1");

    expect(outcome?.unknownTargets).toEqual(["repo-ghost"]);
    // The problem's own repository is used instead, so planning still works.
    expect(outcome?.specification.targets.map((target) => target.repositoryId)).toEqual([
      "repo-x",
    ]);
  });
});

describe("normalizeDerived", () => {
  it("forces exactly one primary target and dedupes", () => {
    const derived = normalizeDerived(
      {
        targets: [
          { repositoryId: "repo-a" },
          { repositoryId: "repo-a" },
          { repositoryId: "repo-b", role: "supporting" },
        ],
      },
      [{ id: "repo-a", name: "a" }, { id: "repo-b", name: "b" }],
    );
    expect(derived.targets).toEqual([
      { repositoryId: "repo-a", role: "primary" },
      { repositoryId: "repo-b", role: "supporting" },
    ]);
  });
});
