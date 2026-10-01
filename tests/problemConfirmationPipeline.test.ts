import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationService } from "../src/conversation/service.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";
import { PROBLEM_ANSWER_ACTION, renderProblemMessage } from "../src/channel/rendering/problem.js";
import {
  CommandDispatcher,
  InMemoryIdempotencyStore,
  ScriptedIntentEngine,
  handleIntent,
  type AuthorizationContext,
  type IntentInput,
} from "../src/command/index.js";
import { createProblemCommandHandlers } from "../src/command/handlers/problem.js";
import { ScriptedProblemAnalyzer } from "../src/problem/application/analyzer.js";
import { ProblemService } from "../src/problem/application/service.js";
import { ConfirmationLoop } from "../src/problem/confirmationLoop.js";
import type { ProblemAnalysisResult } from "../src/problem/analyzer.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { FeishuEventIngestion } from "../src/channel/feishu/webhook.js";

function feishuEventBody(messageId: string, eventId: string, text: string): string {
  const template = JSON.parse(
    readFileSync(
      join(process.cwd(), "src/channel/feishu/fixtures/message.json"),
      "utf8",
    ),
  ) as {
    header: Record<string, unknown>;
    event: { message: Record<string, unknown> };
  };
  template.header.event_id = eventId;
  template.event.message.message_id = messageId;
  template.event.message.content = JSON.stringify({ text });
  return JSON.stringify(template);
}

function needsInput(question = "影响范围是什么？"): ProblemAnalysisResult {
  return {
    summary: "需要确认影响范围",
    needsInput: true,
    uncertainties: ["scope"],
    clarifications: [
      {
        question,
        type: "fact",
        required: true,
        options: [
          { id: "all_users", label: "所有用户" },
          { id: "some_users", label: "部分用户" },
        ],
        reason: "决定问题范围",
      },
    ],
  };
}

const SUFFICIENT: ProblemAnalysisResult = {
  summary: "信息充分",
  needsInput: false,
  uncertainties: [],
  clarifications: [],
};

function message(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    channel: "feishu",
    conversationId: "conv-001",
    messageId: "message-001",
    senderId: "ou_user_1",
    text: "首页加载很慢",
    ...overrides,
  };
}

function context(roles: AuthorizationContext["roles"], userId = "ou_user_1"): AuthorizationContext {
  return { channel: "feishu", userId, roles };
}

async function setup(analyses: ProblemAnalysisResult[]) {
  const problems = new InMemoryProblemStore();
  const loop = new ConfirmationLoop({
    problems,
    analyzer: new ScriptedProblemAnalyzer(analyses),
  });
  const problemService = new ProblemService(problems, loop);
  const conversationStore = new InMemoryConversationStore();
  await conversationStore.createConversation({
    id: "conv-001",
    channel: "feishu",
    externalChatId: "conv-001",
  });
  const conversations = new ConversationService(conversationStore);
  const dispatcher = new CommandDispatcher({
    handlers: createProblemCommandHandlers({
      problems: problemService,
      conversations,
    }),
    idempotency: new InMemoryIdempotencyStore(),
  });
  return { problems, conversations, conversationStore, problemService, dispatcher };
}

describe("Problem confirmation via commands (TASK-1107)", () => {
  it("runs message → problem.create → clarification → OutgoingMessage", async () => {
    const { problems, conversations, dispatcher } = await setup([needsInput()]);
    const engine = new ScriptedIntentEngine({
      command: {
        type: "problem.create",
        payload: { title: "首页加载很慢", statement: "用户反馈首页加载很慢。" },
      },
    });

    const result = await handleIntent(message(), context(["guest"]), {
      engine,
      dispatcher,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
    const data = result.data as {
      problem: { id: string; status: string };
      needsInput: boolean;
      clarifications: { id: string; options: { id: string; label: string }[] }[];
    };
    expect(data.problem.status).toBe("NEEDS_INPUT");
    expect(data.needsInput).toBe(true);
    expect(data.clarifications).toHaveLength(1);
    expect(data.clarifications[0]?.options.map((option) => option.id)).toEqual([
      "all_users",
      "some_users",
    ]);

    // Conversation ↔ Problem link.
    const conversation = await conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "conv-001",
    });
    expect(conversation.subjectType).toBe("problem");
    expect(conversation.subjectId).toBe(data.problem.id);

    // Structured clarifications render as a multi-select choice group whose
    // submit carries every ticked option at once (TASK-1216).
    const problem = await problems.findProblem(data.problem.id);
    const rendered = renderProblemMessage(problem, {
      needsInput: true,
      clarifications: await problems.listClarifications(problem.id),
    });
    const text = JSON.stringify(rendered.blocks);
    expect(text).toContain("所有用户");
    const choices = (rendered.blocks ?? []).filter(
      (block) => block.type === "choice",
    );
    expect(choices).toHaveLength(1);
    expect(JSON.stringify(choices)).toContain(PROBLEM_ANSWER_ACTION);
    expect(JSON.stringify(choices)).toContain("all_users");
  });

  it("answers one clarification with several ticked options at once (TASK-1216)", async () => {
    const { problemService } = await setup([needsInput(), SUFFICIENT]);
    const created = await problemService.create({ title: "首页加载很慢", statement: "慢。" });
    const clarification = created.clarifications[0]!;

    await problemService.answer(created.problem.id, clarification.id, {
      optionIds: ["all_users", "some_users"],
    });

    const [answered] = await problemService.listClarifications(created.problem.id);
    expect(answered?.status).toBe("ANSWERED");
    expect(answered?.answer?.text).toBe("所有用户、部分用户");
    expect(answered?.answer?.optionId).toBeUndefined();
  });

  it("keeps the single-option path exact when only one option is ticked", async () => {
    const { problemService } = await setup([needsInput(), SUFFICIENT]);
    const created = await problemService.create({ title: "首页加载很慢", statement: "慢。" });
    const clarification = created.clarifications[0]!;

    await problemService.answer(created.problem.id, clarification.id, {
      optionIds: ["all_users"],
    });

    const [answered] = await problemService.listClarifications(created.problem.id);
    expect(answered?.answer?.optionId).toBe("all_users");
  });

  it("rejects an option that was never offered", async () => {
    const { problemService } = await setup([needsInput(), SUFFICIENT]);
    const created = await problemService.create({ title: "首页加载很慢", statement: "慢。" });
    const clarification = created.clarifications[0]!;

    await expect(
      problemService.answer(created.problem.id, clarification.id, { optionIds: ["nope"] }),
    ).rejects.toThrow(/no option 'nope'/);
  });

  it("creates exactly one problem for a duplicated command", async () => {
    const { problems, dispatcher } = await setup([needsInput()]);
    const engine = new ScriptedIntentEngine({
      command: {
        type: "problem.create",
        payload: { title: "首页加载很慢", statement: "用户反馈慢。" },
      },
    });

    const first = await handleIntent(message(), context(["guest"]), { engine, dispatcher });
    const retry = await handleIntent(message(), context(["guest"]), { engine, dispatcher });

    expect(first.status).toBe("succeeded");
    expect(retry).toMatchObject({ status: "succeeded", replayed: true });
    await expect(problems.listProblems()).resolves.toHaveLength(1);
  });

  it("answers a clarification and reaches CONFIRMED", async () => {
    const { problems, dispatcher } = await setup([needsInput(), SUFFICIENT]);
    const createEngine = new ScriptedIntentEngine({
      command: {
        type: "problem.create",
        payload: { title: "首页加载很慢", statement: "用户反馈慢。" },
      },
    });
    const created = await handleIntent(message(), context(["guest"]), {
      engine: createEngine,
      dispatcher,
    });
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const clarificationId = (created.data as { clarifications: { id: string }[] })
      .clarifications[0]!.id;

    const answerEngine = new ScriptedIntentEngine({
      command: {
        type: "problem.clarification.answer",
        payload: { problemId, clarificationId, optionId: "all_users" },
      },
    });
    const answered = await handleIntent(
      message({ messageId: "message-002" }),
      context(["guest"]),
      { engine: answerEngine, dispatcher },
    );

    expect(answered.status).toBe("succeeded");
    expect((answered.data as { problem: { status: string } }).problem.status).toBe(
      "CONFIRMED",
    );
    await expect(problems.findProblem(problemId)).resolves.toMatchObject({
      status: "CONFIRMED",
    });
  });

  it("re-analyzes when the answer is still insufficient", async () => {
    const { problems, dispatcher } = await setup([
      needsInput("影响范围是什么？"),
      needsInput("使用什么浏览器？"),
    ]);
    const created = await handleIntent(
      message(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: {
            type: "problem.create",
            payload: { title: "t", statement: "s" },
          },
        }),
        dispatcher,
      },
    );
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const clarificationId = (created.data as { clarifications: { id: string }[] })
      .clarifications[0]!.id;

    const answered = await handleIntent(
      message({ messageId: "message-002" }),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: {
            type: "problem.clarification.answer",
            payload: { problemId, clarificationId, optionId: "all_users" },
          },
        }),
        dispatcher,
      },
    );

    const data = answered.data as {
      problem: { status: string };
      needsInput: boolean;
      clarifications: { question: string }[];
    };
    expect(data.problem.status).toBe("NEEDS_INPUT");
    expect(data.needsInput).toBe(true);
    expect(data.clarifications[0]?.question).toBe("使用什么浏览器？");
    await expect(problems.listClarifications(problemId)).resolves.toHaveLength(2);
  });

  it("rejects problem.confirm while a required clarification is open", async () => {
    const { problems, dispatcher } = await setup([needsInput()]);
    const created = await handleIntent(
      message(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: {
            type: "problem.create",
            payload: { title: "t", statement: "s" },
          },
        }),
        dispatcher,
      },
    );
    const problemId = (created.data as { problem: { id: string } }).problem.id;

    const confirm = await handleIntent(
      message({ messageId: "message-002" }),
      context(["developer"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "problem.confirm", payload: { problemId } },
        }),
        dispatcher,
      },
    );

    expect(confirm).toMatchObject({
      status: "rejected",
      error: { code: "required_clarification_pending" },
    });
    await expect(problems.findProblem(problemId)).resolves.toMatchObject({
      status: "NEEDS_INPUT",
    });
  });

  it("confirms once no clarification is open", async () => {
    const { problems, dispatcher } = await setup([needsInput(), SUFFICIENT]);
    const created = await handleIntent(
      message(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: {
            type: "problem.create",
            payload: { title: "t", statement: "s" },
          },
        }),
        dispatcher,
      },
    );
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const clarificationId = (created.data as { clarifications: { id: string }[] })
      .clarifications[0]!.id;
    await handleIntent(
      message({ messageId: "message-002" }),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: {
            type: "problem.clarification.answer",
            payload: { problemId, clarificationId, optionId: "all_users" },
          },
        }),
        dispatcher,
      },
    );

    const confirm = await handleIntent(
      message({ messageId: "message-003" }),
      context(["developer"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "problem.confirm", payload: { problemId } },
        }),
        dispatcher,
      },
    );

    expect(confirm.status).toBe("succeeded");
    await expect(problems.findProblem(problemId)).resolves.toMatchObject({
      status: "CONFIRMED",
    });
  });

  it("keeps answer idempotent: no second analysis for the same command key", async () => {
    const { problems, dispatcher } = await setup([needsInput(), SUFFICIENT]);
    const created = await handleIntent(
      message(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: {
            type: "problem.create",
            payload: { title: "t", statement: "s" },
          },
        }),
        dispatcher,
      },
    );
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const clarificationId = (created.data as { clarifications: { id: string }[] })
      .clarifications[0]!.id;
    const answerEngine = new ScriptedIntentEngine({
      command: {
        type: "problem.clarification.answer",
        payload: { problemId, clarificationId, optionId: "all_users" },
      },
    });

    const first = await handleIntent(
      message({ messageId: "message-002" }),
      context(["guest"]),
      { engine: answerEngine, dispatcher },
    );
    const retry = await handleIntent(
      message({ messageId: "message-002" }),
      context(["guest"]),
      { engine: answerEngine, dispatcher },
    );

    expect(first.status).toBe("succeeded");
    expect(retry).toMatchObject({ status: "succeeded", replayed: true });
    // Only the two analyses from create+first answer exist.
    await expect(problems.listAnalyses(problemId)).resolves.toHaveLength(2);
  });

  it("rejects an answer for a clarification of another problem", async () => {
    const { dispatcher } = await setup([needsInput(), needsInput()]);
    const createdA = await handleIntent(
      message(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "problem.create", payload: { title: "a", statement: "a" } },
        }),
        dispatcher,
      },
    );
    const createdB = await handleIntent(
      message({ messageId: "message-010" }),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "problem.create", payload: { title: "b", statement: "b" } },
        }),
        dispatcher,
      },
    );
    const problemA = (createdA.data as { problem: { id: string } }).problem.id;
    const clarificationA = (createdA.data as { clarifications: { id: string }[] })
      .clarifications[0]!.id;
    const problemB = (createdB.data as { problem: { id: string } }).problem.id;

    const result = await handleIntent(
      message({ messageId: "message-011" }),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: {
            type: "problem.clarification.answer",
            payload: { problemId: problemB, clarificationId: clarificationA, optionId: "all_users" },
          },
        }),
        dispatcher,
      },
    );

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "invalid_clarification" },
    });
    void problemA;
  });

  it("accepts free-text answers when they are not an offered option", async () => {
    const { problems, dispatcher } = await setup([needsInput(), SUFFICIENT]);
    const created = await handleIntent(
      message(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "problem.create", payload: { title: "t", statement: "s" } },
        }),
        dispatcher,
      },
    );
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const clarificationId = (created.data as { clarifications: { id: string }[] })
      .clarifications[0]!.id;

    const answered = await handleIntent(
      message({ messageId: "message-002" }),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: {
            type: "problem.clarification.answer",
            payload: { problemId, clarificationId, answer: "只在 Safari 上出现过" },
          },
        }),
        dispatcher,
      },
    );

    expect(answered.status).toBe("succeeded");
    const clarification = await problems.findClarification(clarificationId);
    expect(clarification.answer?.text).toContain("Safari");
  });

  it("keeps conversation state independent from problem lifecycle", async () => {
    const { problems, conversations, dispatcher } = await setup([needsInput()]);
    const created = await handleIntent(
      message(),
      context(["guest"]),
      {
        engine: new ScriptedIntentEngine({
          command: { type: "problem.create", payload: { title: "t", statement: "s" } },
        }),
        dispatcher,
      },
    );
    const problemId = (created.data as { problem: { id: string } }).problem.id;
    const conversation = await conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "conv-001",
    });

    await conversations.recordOutgoing(conversation.id, { text: "ack" });
    await conversations.attachSubject(conversation.id, { type: "problem", id: problemId });

    expect((await conversations.findConversation(conversation.id)).status).toBe("ACTIVE");
    await expect(problems.findProblem(problemId)).resolves.toMatchObject({
      status: "NEEDS_INPUT",
    });
  });

  it("runs the full Feishu event → conversation → command → problem chain", async () => {
    const { problems, conversations, dispatcher } = await setup([needsInput(), SUFFICIENT]);
    let answerPayload: Record<string, unknown> | undefined;
    const engine = new ScriptedIntentEngine(async (input) => {
      if (input.messageId === "om_message_001") {
        return {
          command: {
            type: "problem.create",
            payload: { title: "首页加载很慢", statement: "用户反馈首页加载很慢。" },
          },
        };
      }
      return { command: { type: "problem.clarification.answer", payload: answerPayload! } };
    });
    const ingestion = new FeishuEventIngestion({
      conversation: conversations,
      onMessage: async (message, ctx) => {
        await handleIntent(
          {
            channel: message.channel,
            conversationId: ctx.conversationId,
            messageId: message.messageId,
            senderId: message.senderId,
            text: message.text,
          },
          context(["guest"]),
          { engine, dispatcher },
        );
      },
    });

    const first = await ingestion.handleRequest({
      headers: {},
      body: feishuEventBody("om_message_001", "evt-101", "首页加载很慢"),
    });
    expect(first.status).toBe(200);

    const created = (await problems.listProblems())[0]!;
    expect(created.status).toBe("NEEDS_INPUT");
    const clarifications = await problems.listClarifications(created.id, { status: "OPEN" });
    expect(clarifications).toHaveLength(1);
    const conversation = await conversations.getOrCreate({
      channel: "feishu",
      externalChatId: "oc_chat_1",
    });
    expect(conversation.subjectType).toBe("problem");
    expect(conversation.subjectId).toBe(created.id);

    answerPayload = {
      problemId: created.id,
      clarificationId: clarifications[0]!.id,
      optionId: "all_users",
    };
    const second = await ingestion.handleRequest({
      headers: {},
      body: feishuEventBody("om_message_002", "evt-102", "所有用户"),
    });
    expect(second.status).toBe(200);

    await expect(problems.findProblem(created.id)).resolves.toMatchObject({
      status: "CONFIRMED",
    });
    const messages = await conversations.context(conversation.id);
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });
});
