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
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

interface TestHarness {
  specifications: InMemorySpecificationStore;
  plans: InMemorySpecificationPlanStore;
  tasks: InMemoryTaskStore;
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
  const planning = new PlanningService({
    specifications,
    plans,
    tasks,
    planner: new DeterministicTaskPlanner(),
    events,
  });
  const dispatcher = new CommandDispatcher({
    handlers: createSpecificationCommandHandlers({ planning }),
    idempotency: new InMemoryIdempotencyStore(),
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

  return { specifications, plans, tasks, dispatcher, dispatch };
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
    expect(JSON.stringify(data.message.blocks)).toContain("PLANNED");
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
