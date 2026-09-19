import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationService } from "../../../src/conversation/service.js";
import {
  CommandDispatcher,
  InMemoryIdempotencyStore,
  ScriptedIntentEngine,
  handleIntent,
  type AuthorizationContext,
  type CommandResult,
  type Role,
} from "../../../src/command/index.js";
import { createProblemCommandHandlers } from "../../../src/command/handlers/problem.js";
import { createSpecificationCommandHandlers } from "../../../src/command/handlers/specification.js";
import { FeishuEventIngestion } from "../../../src/channel/feishu/webhook.js";
import type { ProblemAnalysisResult } from "../../../src/problem/analyzer.js";
import { ScriptedProblemAnalyzer } from "../../../src/problem/application/analyzer.js";
import { ProblemService } from "../../../src/problem/application/service.js";
import { ConfirmationLoop } from "../../../src/problem/confirmationLoop.js";
import { PlanningService } from "../../../src/specification/application/planning.js";
import { DeterministicTaskPlanner } from "../../../src/specification/application/planner.js";
import { SpecificationService } from "../../../src/specification/application/service.js";
import { InMemoryConversationStore } from "../../../src/store/inMemoryConversationStore.js";
import { InMemoryEventStore } from "../../../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../../../src/store/inMemoryProblemStore.js";
import { InMemorySpecificationPlanStore } from "../../../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../../../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../../../src/store/inMemoryTaskStore.js";

const SUFFICIENT: ProblemAnalysisResult = {
  summary: "问题已明确",
  needsInput: false,
  uncertainties: [],
  clarifications: [],
};

function feishuEventBody(messageId: string, eventId: string, text: string): string {
  const template = JSON.parse(
    readFileSync(
      join(process.cwd(), "src/channel/feishu/fixtures/message.json"),
      "utf8",
    ),
  ) as { header: Record<string, unknown>; event: { message: Record<string, unknown> } };
  template.header.event_id = eventId;
  template.event.message.message_id = messageId;
  template.event.message.content = JSON.stringify({ text });
  return JSON.stringify(template);
}

async function createHarness() {
  const problems = new InMemoryProblemStore();
  const specifications = new InMemorySpecificationStore();
  const plans = new InMemorySpecificationPlanStore();
  const tasks = new InMemoryTaskStore();
  const events = new InMemoryEventStore();
  const conversationStore = new InMemoryConversationStore();

  const loop = new ConfirmationLoop({
    problems,
    analyzer: new ScriptedProblemAnalyzer(SUFFICIENT),
    events,
  });
  const problemService = new ProblemService(problems, loop);
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
  const conversations = new ConversationService(conversationStore);

  const dispatcher = new CommandDispatcher({
    handlers: {
      ...createProblemCommandHandlers({ problems: problemService, conversations }),
      ...createSpecificationCommandHandlers({ planning }),
    },
    idempotency: new InMemoryIdempotencyStore(),
  });

  const dispatch = (
    type: string,
    payload: Record<string, unknown>,
    options: {
      roles?: Role[];
      messageId?: string;
      channel?: string;
      conversationId?: string;
    } = {},
  ): Promise<CommandResult> => {
    const context: AuthorizationContext = {
      channel: options.channel ?? "cli",
      userId: "cli-user",
      roles: options.roles ?? ["developer"],
    };
    return handleIntent(
      {
        channel: context.channel,
        conversationId: options.conversationId ?? "conv-phase12",
        messageId: options.messageId ?? "msg-001",
        senderId: context.userId,
        text: "phase12",
      },
      context,
      {
        engine: new ScriptedIntentEngine({ command: { type, payload } }),
        dispatcher,
      },
    );
  };

  const pendingIntents = new Map<string, { command: unknown; roles: Role[] }>();
  const ingestion = new FeishuEventIngestion({
    conversation: conversations,
    onMessage: async (message, ctx) => {
      const pending = pendingIntents.get(message.messageId);
      if (!pending) {
        return;
      }
      await handleIntent(
        {
          channel: "feishu",
          conversationId: ctx.conversationId,
          messageId: message.messageId,
          senderId: message.senderId,
          text: message.text,
        },
        { channel: "feishu", userId: message.senderId, roles: pending.roles },
        {
          engine: new ScriptedIntentEngine({ command: pending.command }),
          dispatcher,
        },
      );
    },
  });

  const dispatchFeishu = async (input: {
    messageId: string;
    eventId: string;
    command: unknown;
    roles?: Role[];
  }) => {
    pendingIntents.set(input.messageId, {
      command: input.command,
      roles: input.roles ?? ["developer"],
    });
    return ingestion.handleRequest({
      headers: {},
      body: feishuEventBody(input.messageId, input.eventId, "phase12"),
    });
  };

  return {
    problems,
    specifications,
    plans,
    tasks,
    events,
    problemService,
    specificationService,
    planning,
    dispatch,
    dispatchFeishu,
  };
}

describe("Phase 12 E2E — Specification → Task Planning (TASK-1202)", () => {
  it("runs Problem → Specification → plan → N Tasks → PLANNED", async () => {
    const h = await createHarness();

    // 1. Problem → CONFIRMED
    const created = await h.dispatch("problem.create", {
      title: "专辑页面",
      statement: "用户希望有一个专辑页面。",
    });
    expect(created.status).toBe("succeeded");
    const problemId = (created.data as { problem: { id: string; status: string } }).problem.id;
    expect((created.data as { problem: { status: string } }).problem.status).toBe(
      "CONFIRMED",
    );

    // 2. CONFIRMED Problem → DRAFT → READY Specification
    const specification = await h.specificationService.createFromProblem({
      problemId,
      requirements: ["列表页显示曲目", "详情页显示歌词"],
      acceptance: ["可以打开专辑页"],
    });
    await h.specificationService.update(specification.id, {
      targets: [
        { repositoryId: "repo-a", role: "primary", position: 0 },
        { repositoryId: "repo-b", role: "supporting", position: 1 },
      ],
    });
    const ready = await h.specificationService.markReady(specification.id);
    expect(ready.status).toBe("READY");

    // 3. spec.plan → N Tasks → PLANNED
    const planned = await h.dispatch("spec.plan", {
      specificationId: specification.id,
    });
    expect(planned.status).toBe("succeeded");
    const data = planned.data as {
      specification: { status: string };
      planItems: { taskId?: string }[];
      tasks: { id: string; status: string; acceptance: string[] }[];
      replayed: boolean;
    };
    expect(data.specification.status).toBe("PLANNED");
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks.map((task) => task.status)).toEqual(["INBOX", "INBOX"]);
    expect(data.tasks[0]?.acceptance).toEqual(["可以打开专辑页"]);
    expect(data.planItems.map((item) => item.taskId)).toEqual(
      data.tasks.map((task) => task.id),
    );

    // 4. spec.show reflects the same facts
    const shown = await h.dispatch(
      "spec.show",
      { specificationId: specification.id },
      { messageId: "msg-show", roles: ["guest"] },
    );
    expect(shown.status).toBe("succeeded");
    expect(JSON.stringify((shown.data as { message: unknown }).message)).toContain(
      "PLANNED",
    );

    // 5. Nothing executed: planning never creates Runs
    await expect(
      h.events.listEvents({ type: "specification.planned" }),
    ).resolves.toHaveLength(1);
    await expect(h.tasks.listTasks()).resolves.toHaveLength(2);
  });

  it("keeps spec.plan idempotent, including across Feishu redelivery", async () => {
    const h = await createHarness();
    const created = await h.dispatch("problem.create", {
      title: "专辑页面",
      statement: "用户希望有一个专辑页面。",
    });
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const specification = await h.specificationService.createFromProblem({
      problemId,
      requirements: ["列表页显示曲目"],
      acceptance: ["可以打开专辑页"],
      targets: [{ repositoryId: "repo-a" }],
    });
    await h.specificationService.markReady(specification.id);

    const first = await h.dispatchFeishu({
      messageId: "msg-plan",
      eventId: "evt-1",
      command: { type: "spec.plan", payload: { specificationId: specification.id } },
    });
    const redelivered = await h.dispatchFeishu({
      messageId: "msg-plan",
      eventId: "evt-1",
      command: { type: "spec.plan", payload: { specificationId: specification.id } },
    });
    const again = await h.dispatchFeishu({
      messageId: "msg-plan-2",
      eventId: "evt-2",
      command: { type: "spec.plan", payload: { specificationId: specification.id } },
    });

    expect(first).toMatchObject({ status: 200 });
    expect(redelivered.body).toMatchObject({ duplicate: true });
    expect(again).toMatchObject({ status: 200 });

    const tasks = await h.tasks.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(`task-${specification.id}-0`);
    const planItems = await h.plans.listPlanItems(specification.id);
    expect(planItems).toHaveLength(1);
    expect(planItems[0]?.taskId).toBe(tasks[0]?.id);
  });

  it("rejects planning for DRAFT and unknown specifications", async () => {
    const h = await createHarness();
    const created = await h.dispatch("problem.create", {
      title: "专辑页面",
      statement: "用户希望有一个专辑页面。",
    });
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const draft = await h.specificationService.createFromProblem({
      problemId,
      acceptance: ["可以打开专辑页"],
      targets: [{ repositoryId: "repo-a" }],
    });

    await expect(
      h.dispatch("spec.plan", { specificationId: draft.id }, { messageId: "msg-draft" }),
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
    await expect(h.tasks.listTasks()).resolves.toHaveLength(0);
    await expect(h.specifications.findSpecification(draft.id)).resolves.toMatchObject({
      status: "DRAFT",
    });
  });
});
