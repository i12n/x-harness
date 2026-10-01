import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { createDeliveryCommandHandlers } from "../../../src/command/handlers/delivery.js";
import { DeliveryService } from "../../../src/delivery/application/service.js";
import { FeishuEventIngestion } from "../../../src/channel/feishu/webhook.js";
import type { ProblemAnalysisResult } from "../../../src/problem/analyzer.js";
import { ScriptedProblemAnalyzer } from "../../../src/problem/application/analyzer.js";
import { ProblemService } from "../../../src/problem/application/service.js";
import { ConfirmationLoop } from "../../../src/problem/confirmationLoop.js";
import { PlanningService } from "../../../src/specification/application/planning.js";
import { DeterministicTaskPlanner } from "../../../src/specification/application/planner.js";
import { SpecificationService } from "../../../src/specification/application/service.js";
import { TaskDependencyService } from "../../../src/task/application/dependencyService.js";
import { InMemoryConversationStore } from "../../../src/store/inMemoryConversationStore.js";
import { InMemoryDeliveryStore } from "../../../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../../../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../../../src/store/inMemoryProblemStore.js";
import { InMemorySpecificationPlanStore } from "../../../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../../../src/store/inMemorySpecificationStore.js";
import { InMemoryRunStore } from "../../../src/store/inMemoryRunStore.js";
import { InMemoryTaskDependencyStore } from "../../../src/store/inMemoryTaskDependencyStore.js";
import { InMemoryTaskStore } from "../../../src/store/inMemoryTaskStore.js";

const SUFFICIENT: ProblemAnalysisResult = {
  summary: "问题已明确",
  needsInput: false,
  uncertainties: [],
  clarifications: [],
};

export interface Phase12CommandInput {
  roles?: Role[];
  messageId?: string;
  channel?: string;
  conversationId?: string;
  senderId?: string;
}

/**
 * Shared Phase 12 harness: Problem → Specification → Planning → Dependencies,
 * with the command layer (CLI + Feishu fixtures) on top. It deliberately has
 * no Scheduler/Worker/Run wiring: Phase 12 up to TASK-1203 does not execute.
 */
export async function createPhase12Harness() {
  const problems = new InMemoryProblemStore();
  const specifications = new InMemorySpecificationStore();
  const plans = new InMemorySpecificationPlanStore();
  const tasks = new InMemoryTaskStore();
  const dependencies = new InMemoryTaskDependencyStore();
  const deliveries = new InMemoryDeliveryStore();
  // No execution in this harness, but the delivery view reads failed runs for
  // evidence, so the store exists (empty) for callers that seed runs.
  const runs = new InMemoryRunStore();
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
  const dependencyService = new TaskDependencyService({
    tasks,
    dependencies,
    events,
  });
  // TASK-1207 Phase C: the delivery view carries dependency impact + evidence.
  const deliveryService = new DeliveryService({
    deliveries,
    plans,
    tasks,
    events,
    impacts: dependencyService,
    runs,
  });
  const planning = new PlanningService({
    specifications,
    plans,
    tasks,
    planner: new DeterministicTaskPlanner(),
    events,
    // TASK-1205: planning a Specification creates its Delivery.
    deliveries: deliveryService,
  });
  const conversations = new ConversationService(conversationStore);

  const dispatcher = new CommandDispatcher({
    handlers: {
      ...createProblemCommandHandlers({ problems: problemService, conversations }),
      ...createSpecificationCommandHandlers({
        planning,
        specification: specificationService,
      }),
      ...createDeliveryCommandHandlers({ deliveries: deliveryService }),
    },
    idempotency: new InMemoryIdempotencyStore(),
  });

  const dispatch = (
    type: string,
    payload: Record<string, unknown>,
    options: Phase12CommandInput = {},
  ): Promise<CommandResult> => {
    const senderId = options.senderId ?? "cli-user";
    const context: AuthorizationContext = {
      channel: options.channel ?? "cli",
      userId: senderId,
      roles: options.roles ?? ["developer"],
    };
    return handleIntent(
      {
        channel: context.channel,
        conversationId: options.conversationId ?? "conv-phase12",
        messageId: options.messageId ?? "msg-001",
        senderId,
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

  /** Creates a CONFIRMED problem, then a READY specification for it. */
  const seedReadySpecification = async (
    options: {
      problemId?: string;
      title?: string;
      requirements: string[];
      acceptance?: string[];
      targets?: { repositoryId: string; role?: "primary" | "supporting" }[];
    },
  ) => {
    const created = await dispatch("problem.create", {
      title: options.title ?? "专辑页面",
      statement: "用户希望有一个专辑页面。",
    });
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const specification = await specificationService.createFromProblem({
      problemId,
      requirements: options.requirements,
      acceptance: options.acceptance ?? ["可以打开专辑页"],
      targets: options.targets ?? [{ repositoryId: "repo-a" }],
    });
    await specificationService.markReady(specification.id);
    return specification;
  };

  return {
    problems,
    specifications,
    plans,
    tasks,
    runs,
    dependencies,
    deliveries,
    events,
    problemService,
    specificationService,
    planning,
    dependencyService,
    deliveryService,
    dispatcher,
    dispatch,
    dispatchFeishu,
    seedReadySpecification,
  };
}

export function feishuEventBody(
  messageId: string,
  eventId: string,
  text: string,
): string {
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
