import { describe, expect, it } from "vitest";
import {
  CommandDispatcher,
  InMemoryIdempotencyStore,
  ScriptedIntentEngine,
  handleIntent,
  type AuthorizationContext,
  type CommandResult,
  type Role,
} from "../src/command/index.js";
import { createSpecificationCommandHandlers } from "../src/command/handlers/specification.js";
import { PlanningService } from "../src/specification/application/planning.js";
import { DeterministicTaskPlanner } from "../src/specification/application/planner.js";
import { SpecificationService } from "../src/specification/application/service.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

interface TestHarness {
  specifications: InMemorySpecificationStore;
  plans: InMemorySpecificationPlanStore;
  tasks: InMemoryTaskStore;
  problems: InMemoryProblemStore;
  events: InMemoryEventStore;
  dispatcher: CommandDispatcher;
  dispatch(
    type: string,
    payload: Record<string, unknown>,
    options?: { roles?: Role[]; messageId?: string; channel?: string; senderId?: string },
  ): Promise<CommandResult>;
}

async function harness(): Promise<TestHarness> {
  const specifications = new InMemorySpecificationStore();
  const plans = new InMemorySpecificationPlanStore();
  const tasks = new InMemoryTaskStore();
  const events = new InMemoryEventStore();
  const problems = new InMemoryProblemStore();
  const specificationService = new SpecificationService({
    specifications,
    problems,
    events,
  });
  const planning = new PlanningService({
    specifications,
    plans,
    tasks,
    planner: new DeterministicTaskPlanner(),
    events,
  });
  const dispatcher = new CommandDispatcher({
    handlers: createSpecificationCommandHandlers({
      planning,
      specification: specificationService,
    }),
    idempotency: new InMemoryIdempotencyStore(),
  });

  await problems.createProblem({
    id: "prob-confirmed",
    title: "专辑页面",
    statement: "用户希望有一个专辑页面。",
    repositoryId: "repo-a",
    status: "CONFIRMED",
  });
  await problems.setProblemSpec("prob-confirmed", {
    problem: "专辑页面不存在",
    expected: "可以浏览专辑曲目",
    scope: "所有用户",
  });
  await problems.createProblem({
    id: "prob-open",
    title: "还没想清楚",
    statement: "用户希望有一个专辑页面。",
    repositoryId: "repo-a",
    status: "NEEDS_INPUT",
  });

  await specifications.createSpecification({
    id: "spec-001",
    problemId: "prob-001",
    title: "专辑页面",
    summary: "浏览专辑曲目",
    acceptance: ["可以打开专辑页"],
    status: "READY",
    requirements: ["列表页显示曲目", "详情页显示歌词"],
    targets: [{ repositoryId: "repo-a", role: "primary", position: 0 }],
  });
  await specifications.createSpecification({
    id: "spec-draft",
    problemId: "prob-002",
    title: "草稿",
    status: "DRAFT",
    targets: [{ repositoryId: "repo-a", role: "primary", position: 0 }],
  });

  const dispatch = (
    type: string,
    payload: Record<string, unknown>,
    options: { roles?: Role[]; messageId?: string; channel?: string; senderId?: string } = {},
  ): Promise<CommandResult> => {
    const context: AuthorizationContext = {
      channel: options.channel ?? "cli",
      userId: options.senderId ?? "cli-user",
      roles: options.roles ?? ["developer"],
    };
    return handleIntent(
      {
        channel: context.channel,
        conversationId: "conv-001",
        messageId: options.messageId ?? "msg-001",
        senderId: context.userId,
        text: "spec",
      },
      context,
      {
        engine: new ScriptedIntentEngine({ command: { type, payload } }),
        dispatcher,
      },
    );
  };

  return { specifications, plans, tasks, problems, events, dispatcher, dispatch };
}

describe("spec.show / spec.plan commands (TASK-1202)", () => {
  it("plans a READY specification through the command layer", async () => {
    const h = await harness();

    const result = await h.dispatch("spec.plan", { specificationId: "spec-001" });

    expect(result.status).toBe("succeeded");
    const data = result.data as {
      specification: { status: string };
      tasks: { id: string }[];
      planItems: { taskId?: string }[];
      replayed: boolean;
      message: { blocks?: unknown[] };
    };
    expect(data.specification.status).toBe("PLANNED");
    expect(data.tasks.map((task) => task.id)).toEqual([
      "task-spec-001-0",
      "task-spec-001-1",
    ]);
    expect(data.replayed).toBe(false);
    expect(JSON.stringify(data.message.blocks)).toContain("task-spec-001-0");
    expect(JSON.stringify(data.message.blocks)).toContain("已拆解");
  });

  it("shows the specification and its plan for guests", async () => {
    const h = await harness();
    await h.dispatch("spec.plan", { specificationId: "spec-001" });

    const result = await h.dispatch(
      "spec.show",
      { specificationId: "spec-001" },
      { roles: ["guest"], messageId: "msg-show" },
    );

    expect(result.status).toBe("succeeded");
    const blocks = JSON.stringify((result.data as { message: unknown }).message);
    expect(blocks).toContain("专辑页面");
    expect(blocks).toContain("列表页显示曲目");
    expect(blocks).toContain("task-spec-001-1");
  });

  it("rejects spec.plan for guests and for non-READY specifications", async () => {
    const h = await harness();

    await expect(
      h.dispatch("spec.plan", { specificationId: "spec-001" }, { roles: ["guest"] }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unauthorized" } });

    await expect(
      h.dispatch("spec.plan", { specificationId: "spec-draft" }, { messageId: "msg-draft" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "specification_not_ready" },
    });
    await expect(
      h.dispatch(
        "spec.plan",
        { specificationId: "spec-missing" },
        { messageId: "msg-missing" },
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "specification_not_found" },
    });
    await expect(
      h.dispatch("spec.plan", { specificationId: 7 }, { messageId: "msg-bad" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "invalid_field_type" },
    });
    await expect(h.tasks.listTasks()).resolves.toHaveLength(0);
  });

  it("is idempotent across replayed messages and duplicate dispatches", async () => {
    const h = await harness();

    const first = await h.dispatch("spec.plan", { specificationId: "spec-001" });
    const sameMessage = await h.dispatch("spec.plan", { specificationId: "spec-001" });
    const newMessage = await h.dispatch(
      "spec.plan",
      { specificationId: "spec-001" },
      { messageId: "msg-002" },
    );

    expect(first.status).toBe("succeeded");
    expect(sameMessage.replayed).toBe(true);
    expect(newMessage.status).toBe("succeeded");
    expect((newMessage.data as { replayed: boolean }).replayed).toBe(true);
    expect(await h.tasks.listTasks()).toHaveLength(2);
  });
});

interface CreatedSpecification {
  specification: {
    id: string;
    problemId: string;
    status: string;
    title: string;
    summary: string;
    requirements: string[];
    acceptance: string[];
    targets: { repositoryId: string; role: string; position: number }[];
  };
  message: unknown;
}

describe("spec.create / spec.update / spec.ready commands (TASK-1210)", () => {
  it("creates a DRAFT from a CONFIRMED problem, deriving the confirmed facts", async () => {
    const h = await harness();

    const result = await h.dispatch("spec.create", { problemId: "prob-confirmed" });

    expect(result.status).toBe("succeeded");
    const data = result.data as CreatedSpecification;
    expect(data.specification).toMatchObject({
      problemId: "prob-confirmed",
      status: "DRAFT",
      title: "专辑页面",
      summary: "可以浏览专辑曲目",
      requirements: ["专辑页面不存在"],
      acceptance: [],
    });
    expect(data.specification.targets).toEqual([
      { repositoryId: "repo-a", role: "primary", position: 0, baseRef: undefined },
    ]);
    await expect(
      h.specifications.findSpecification(data.specification.id),
    ).resolves.toMatchObject({ id: data.specification.id, status: "DRAFT" });
  });

  it("accepts caller-supplied acceptance criteria and target repositories", async () => {
    const h = await harness();

    const result = await h.dispatch("spec.create", {
      problemId: "prob-confirmed",
      title: "专辑页面 v2",
      acceptance: ["可以打开专辑页", "可以播放曲目"],
      repositories: ["repo-a", "repo-b"],
    });

    expect(result.status).toBe("succeeded");
    const data = result.data as CreatedSpecification;
    expect(data.specification).toMatchObject({
      title: "专辑页面 v2",
      acceptance: ["可以打开专辑页", "可以播放曲目"],
    });
    expect(
      data.specification.targets.map((target) => [target.repositoryId, target.role]),
    ).toEqual([
      ["repo-a", "primary"],
      ["repo-b", "supporting"],
    ]);
  });

  it("rejects unknown problems, unconfirmed problems, guests and missing fields", async () => {
    const h = await harness();

    await expect(
      h.dispatch("spec.create", { problemId: "prob-open" }, { messageId: "msg-open" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "problem_not_confirmed" },
    });
    await expect(
      h.dispatch("spec.create", { problemId: "prob-missing" }, { messageId: "msg-missing" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "problem_not_found" },
    });
    await expect(
      h.dispatch(
        "spec.create",
        { problemId: "prob-confirmed" },
        { messageId: "msg-guest", roles: ["guest"] },
      ),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unauthorized" } });
    await expect(
      h.dispatch("spec.create", {}, { messageId: "msg-no-problem" }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "missing_field" } });

    // Nothing was created: the two seeded specifications are still all there is.
    await expect(h.specifications.listSpecifications()).resolves.toHaveLength(2);
  });

  it("rejects malformed list fields before reaching the application", async () => {
    const h = await harness();

    await expect(
      h.dispatch(
        "spec.create",
        { problemId: "prob-confirmed", acceptance: "不是数组" },
        { messageId: "msg-1" },
      ),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "invalid_field_type" } });
    await expect(
      h.dispatch(
        "spec.create",
        { problemId: "prob-confirmed", acceptance: ["可以打开专辑页", "  "] },
        { messageId: "msg-2" },
      ),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "invalid_field_type" } });
    await expect(
      h.dispatch(
        "spec.create",
        { problemId: "prob-confirmed", repositories: "repo-a" },
        { messageId: "msg-3" },
      ),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "invalid_field_type" } });
    await expect(
      h.dispatch(
        "spec.create",
        { problemId: "prob-confirmed", repositories: 7 },
        { messageId: "msg-4" },
      ),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "invalid_field_type" } });
  });

  it("updates only DRAFT specifications and rejects repeated targets", async () => {
    const h = await harness();
    const created = await h.dispatch("spec.create", {
      problemId: "prob-confirmed",
      acceptance: ["可以打开专辑页"],
    });
    const specificationId = (created.data as CreatedSpecification).specification.id;

    const updated = await h.dispatch(
      "spec.update",
      {
        specificationId,
        summary: "新的描述",
        acceptance: ["可以打开专辑页", "可以播放曲目"],
      },
      { messageId: "msg-update" },
    );
    expect(updated.status).toBe("succeeded");
    expect((updated.data as CreatedSpecification).specification).toMatchObject({
      summary: "新的描述",
      acceptance: ["可以打开专辑页", "可以播放曲目"],
    });

    await expect(
      h.dispatch(
        "spec.update",
        { specificationId, repositories: ["repo-a", "repo-a"] },
        { messageId: "msg-duplicate-target" },
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "invalid_specification_input" },
    });

    await h.dispatch("spec.ready", { specificationId }, { messageId: "msg-ready" });
    await expect(
      h.dispatch(
        "spec.update",
        { specificationId, title: "READY 之后不可编辑" },
        { messageId: "msg-frozen" },
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "specification_not_editable" },
    });
  });

  it("closes the main chain: create → update → ready → plan → Tasks", async () => {
    const h = await harness();

    const created = await h.dispatch("spec.create", { problemId: "prob-confirmed" });
    const specificationId = (created.data as CreatedSpecification).specification.id;

    // An incomplete DRAFT (no acceptance criteria) cannot become READY.
    await expect(
      h.dispatch(
        "spec.ready",
        { specificationId },
        { messageId: "msg-too-early" },
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "specification_incomplete" },
    });

    const updated = await h.dispatch(
      "spec.update",
      { specificationId, acceptance: ["可以打开专辑页"], repositories: ["repo-a"] },
      { messageId: "msg-complete" },
    );
    expect(updated.status).toBe("succeeded");

    const ready = await h.dispatch(
      "spec.ready",
      { specificationId },
      { messageId: "msg-ready" },
    );
    expect(ready.status).toBe("succeeded");
    expect((ready.data as CreatedSpecification).specification.status).toBe("READY");

    const planned = await h.dispatch(
      "spec.plan",
      { specificationId },
      { messageId: "msg-plan" },
    );
    expect(planned.status).toBe("succeeded");
    expect(
      (planned.data as { specification: { status: string } }).specification.status,
    ).toBe("PLANNED");
    await expect(h.tasks.listTasks()).resolves.toHaveLength(1);
    await expect(
      h.events.listEvents({ type: "specification.created" }),
    ).resolves.toHaveLength(1);
  });

  it("replays a duplicate create message instead of creating a second specification", async () => {
    const h = await harness();

    const first = await h.dispatch(
      "spec.create",
      { problemId: "prob-confirmed" },
      { messageId: "msg-dup-create" },
    );
    const replay = await h.dispatch(
      "spec.create",
      { problemId: "prob-confirmed" },
      { messageId: "msg-dup-create" },
    );

    expect(first.status).toBe("succeeded");
    expect(replay.replayed).toBe(true);
    await expect(h.specifications.listSpecifications()).resolves.toHaveLength(3);
  });
});
