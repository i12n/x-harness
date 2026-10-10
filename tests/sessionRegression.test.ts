import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OutgoingMessage } from "../src/channel/message.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createProblemCommandHandlers } from "../src/command/handlers/problem.js";
import { createRevisionCommandHandlers } from "../src/command/handlers/revision.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import type { IntentEngine, IntentInput, IntentResult } from "../src/command/types.js";
import { ConversationService } from "../src/conversation/service.js";
import { DeliveryService } from "../src/delivery/application/service.js";
import { ScriptedProblemAnalyzer } from "../src/problem/application/analyzer.js";
import { ProblemService } from "../src/problem/application/service.js";
import { ConfirmationLoop } from "../src/problem/confirmationLoop.js";
import { createRequirementResolver } from "../src/requirement/application/resolver.js";
import { ChatSession } from "../src/server/session.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

/**
 * TASK-1267: the session-layer half of the conversation regression.
 *
 * `conversationRegression` (actions layer) answers "given what we understood,
 * what action comes out". This one answers the branches that only exist inside
 * `ChatSession` — the clarification loop, a rejected problem creation, and the
 * two permission walls — across a real round trip, with real stores.
 */

interface Turn {
  text: string;
  intent: IntentResult;
  expect: {
    replyContains?: string[];
    replyNotContains?: string[];
    engineCalls?: number;
    problems?: number;
    problemsConfirmed?: number;
    openClarifications?: number;
    tasks?: number;
    anchorsToOwnMessage?: boolean;
  };
}

interface Case {
  name: string;
  operator: string;
  brokenCreate?: boolean;
  requirement?: {
    titles?: string[];
    tasks: { id: string; status: string }[];
    delivery: string;
  };
  turns: Turn[];
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "sessionRegression.json"), "utf8"),
);

const ROLES: Record<string, "reviewer" | "developer" | "admin"> = {
  ou_reviewer: "reviewer",
  ou_dev: "developer",
  ou_admin: "admin",
};

class ScriptedEngine implements IntentEngine {
  calls = 0;
  constructor(private readonly results: IntentResult[]) {}
  async parse(_input: IntentInput): Promise<IntentResult> {
    const next = this.results[this.calls] ?? this.results[this.results.length - 1];
    this.calls += 1;
    return next ?? { command: undefined };
  }
}

function event(messageId: string, text: string, openId: string): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { event_id: `evt-${messageId}`, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        message_id: messageId,
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "text",
        create_time: "1758240000000",
        content: JSON.stringify({ text }),
      },
    },
  };
}

function textOf(message: OutgoingMessage): string {
  return [
    message.text ?? "",
    ...(message.blocks ?? []).flatMap((block) =>
      block.type === "markdown" || block.type === "text" || block.type === "section"
        ? [block.text ?? ""]
        : block.type === "choice"
          ? [`${block.title ?? ""} ${block.options.map((option) => option.label).join("/")}`]
          : block.type === "actions"
            ? block.actions.map((action) => `[${action.label}]`)
            : [],
    ),
  ].join("\n");
}

async function runCase(entry: Case) {
  const problems = new InMemoryProblemStore();
  const tasks = new InMemoryTaskStore();
  const runs = new InMemoryRunStore();
  const deliveries = new InMemoryDeliveryStore();
  const plans = new InMemorySpecificationPlanStore();
  const specifications = new InMemorySpecificationStore();
  const events = new InMemoryEventStore();
  const conversationStore = new InMemoryConversationStore();
  const conversations = new ConversationService(conversationStore);

  if (entry.requirement) {
    await problems.createProblem({
      id: "prob-1",
      title: "x-music 添加下载歌曲功能",
      statement: "在歌曲页面加下载",
    });
    await problems.updateProblemStatus("prob-1", "CONFIRMED");
    await specifications.createSpecification({
      id: "spec-1",
      problemId: "prob-1",
      title: "x-music 添加下载歌曲功能",
    });
    for (const [index, task] of entry.requirement.tasks.entries()) {
      const title = entry.requirement.titles?.[index] ?? `开发点 ${index + 1}`;
      await tasks.createTask({
        id: task.id,
        repositoryId: "repo-1",
        title,
        status: task.status as never,
      });
      await plans.createPlanItem({
        specificationId: "spec-1",
        position: index,
        title,
        taskId: task.id,
      });
    }
    await deliveries.createDelivery({
      id: "dlv-1",
      specificationId: "spec-1",
      status: entry.requirement.delivery as never,
    });
    await conversationStore.createConversation({
      id: "conv-1",
      channel: "feishu",
      externalChatId: "oc_chat",
      subjectType: "problem",
      subjectId: "prob-1",
    });
  }

  const problemService = new ProblemService(
    problems,
    new ConfirmationLoop({
      problems,
      events,
      // First analysis asks one question; once answered the loop re-analyzes
      // and the second entry confirms. That is the real clarification cycle.
      analyzer: new ScriptedProblemAnalyzer([
        {
          summary: "需要确认空状态的形态",
          needsInput: true,
          uncertainties: [],
          clarifications: [
            {
              question: "空状态要显示什么？",
              type: "decision",
              required: true,
              reason: "决定实现范围",
              options: [
                { id: "opt-guide", label: "引导文案" },
                { id: "opt-art", label: "插图" },
              ],
            },
          ],
        },
        {
          summary: "范围已经清楚",
          needsInput: false,
          uncertainties: [],
          clarifications: [],
        },
      ]),
    }),
  );
  const deliveryService = new DeliveryService({
    deliveries,
    plans,
    tasks,
    runs,
    events,
  });
  const dispatcher = new CommandDispatcher({
    handlers: {
      ...createProblemCommandHandlers({ problems: problemService, conversations }),
      ...createRevisionCommandHandlers({
        deliveries: deliveryService,
        tasks,
        plans,
        runs,
        events,
      }),
      ...(entry.brokenCreate
        ? {
            "problem.create": async () => {
              throw new Error("problem analyzer returned no valid JSON");
            },
          }
        : {}),
    },
    idempotency: new InMemoryIdempotencyStore(),
  });

  const engine = new ScriptedEngine(entry.turns.map((turn) => turn.intent));
  const sent: { target: unknown; message: OutgoingMessage }[] = [];
  const requirements = createRequirementResolver({
    conversations: conversationStore,
    problems,
    specifications,
    deliveries,
    plans,
    runs,
    tasks,
  });
  const session = new ChatSession({
    conversations,
    intent: engine,
    dispatcher,
    access: {
      allowedUserIds: ["ou_reviewer", "ou_dev", "ou_admin"],
      roleMap: ROLES,
      defaultRole: "guest",
    },
    send: async (target, message) => {
      sent.push({ target, message });
    },
    requirements,
  });

  return { session, sent, engine, problems, tasks, conversations };
}

describe("session regression (TASK-1267)", () => {
  for (const entry of fixture.cases) {
    it(entry.name, async () => {
      const { session, sent, engine, problems, tasks } = await runCase(entry);

      for (const [index, turn] of entry.turns.entries()) {
        const messageId = `om-${index + 1}`;
        // Ids only exist once the previous turn ran, so the fixture marks them
        // and the driver substitutes what is actually in the store.
        await fillPlaceholders(turn.intent, problems);

        await session.handleEvent(event(messageId, turn.text, entry.operator));

        const reply = sent.at(-1)!.message;
        const text = textOf(reply);
        for (const fragment of turn.expect.replyContains ?? []) {
          expect(text, `turn ${index + 1} reply`).toContain(fragment);
        }
        for (const fragment of turn.expect.replyNotContains ?? []) {
          expect(text, `turn ${index + 1} reply`).not.toContain(fragment);
        }
        if (turn.expect.engineCalls !== undefined) {
          expect(engine.calls, `turn ${index + 1} model calls`).toBe(turn.expect.engineCalls);
        }
        if (turn.expect.anchorsToOwnMessage) {
          expect(reply.metadata?.replyToMessageId).toBe(messageId);
        }
        if (turn.expect.problems !== undefined) {
          expect(await problems.listProblems()).toHaveLength(turn.expect.problems);
        }
        if (turn.expect.problemsConfirmed !== undefined) {
          const all = await problems.listProblems();
          expect(all.filter((problem) => problem.status === "CONFIRMED")).toHaveLength(
            turn.expect.problemsConfirmed,
          );
        }
        if (turn.expect.openClarifications !== undefined) {
          const id = (await problems.listProblems())[0]?.id;
          const open = id
            ? (await problems.listClarifications(id)).filter(
                (clarification) => clarification.status === "OPEN",
              )
            : [];
          expect(open).toHaveLength(turn.expect.openClarifications);
        }
        if (turn.expect.tasks !== undefined) {
          expect(await tasks.listTasks()).toHaveLength(turn.expect.tasks);
        }
      }
    });
  }
});

/**
 * `$problemId` / `$firstClarification` / `$firstOption` stand for ids the
 * previous turn created. Substitution happens on the engine's own result, which
 * is what the session is about to read.
 */
async function fillPlaceholders(
  intent: IntentResult,
  problems: InMemoryProblemStore,
): Promise<void> {
  const payload = (intent.command as { payload?: Record<string, unknown> } | undefined)?.payload;
  if (!payload) {
    return;
  }
  if (payload.problemId === "$problemId") {
    payload.problemId = (await problems.listProblems())[0]?.id;
  }
  const problemId = typeof payload.problemId === "string" ? payload.problemId : undefined;
  if (!problemId || payload.clarificationId !== "$firstClarification") {
    return;
  }
  const open = (await problems.listClarifications(problemId)).filter(
    (clarification) => clarification.status === "OPEN",
  );
  const first = open[0];
  if (!first) {
    return;
  }
  payload.clarificationId = first.id;
  payload.optionId =
    payload.optionId === "$firstOption" ? first.options[0]?.id : payload.optionId;
}
