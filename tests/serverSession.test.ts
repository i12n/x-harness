import { describe, expect, it, vi } from "vitest";
import type { OutgoingMessage } from "../src/channel/message.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createProblemCommandHandlers } from "../src/command/handlers/problem.js";
import { createReviewCommandHandlers } from "../src/command/handlers/review.js";
import { createTaskRunCommandHandlers } from "../src/command/handlers/taskRun.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import type { IntentEngine, IntentInput, IntentResult } from "../src/command/types.js";
import { ConversationService } from "../src/conversation/service.js";
import { ScriptedProblemAnalyzer } from "../src/problem/application/analyzer.js";
import { ProblemService } from "../src/problem/application/service.js";
import { ConfirmationLoop } from "../src/problem/confirmationLoop.js";
import { ReviewService } from "../src/review/application/reviewService.js";
import { RunService } from "../src/run/application/runService.js";
import { TaskRunService } from "../src/run/application/taskRunService.js";
import type { ChatTarget, RunChatNotifier } from "../src/server/notifications.js";
import { ChatSession } from "../src/server/session.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";
import type { Worker } from "../src/worker/worker.js";

class StubIntentEngine implements IntentEngine {
  constructor(private result: IntentResult) {}
  seen: IntentInput[] = [];
  async parse(input: IntentInput): Promise<IntentResult> {
    this.seen.push(input);
    return this.result;
  }
}

function event(messageId: string, text: string, openId = "ou_dev"): Record<string, unknown> {
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

async function buildSession(intent: IntentEngine, allowedUserIds = ["ou_dev"]) {
  const problems = new InMemoryProblemStore();
  const tasks = new InMemoryTaskStore();
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const conversations = new ConversationService(new InMemoryConversationStore());

  const problemService = new ProblemService(
    problems,
    new ConfirmationLoop({
      problems,
      events,
      analyzer: new ScriptedProblemAnalyzer({
        summary: "clear enough",
        needsInput: false,
        uncertainties: [],
        clarifications: [],
      }),
    }),
  );
  const taskRun = new TaskRunService({
    tasks,
    runs,
    repositories: new InMemoryRepositoryStore(),
    worker: {} as Worker,
    runMode: "enqueue",
  });
  const dispatcher = new CommandDispatcher({
    handlers: {
      ...createProblemCommandHandlers({ problems: problemService, conversations }),
      ...createTaskRunCommandHandlers({
        taskRun,
        runs: new RunService({ runs, tasks, events }),
      }),
      ...createReviewCommandHandlers({
        reviews: new ReviewService({ tasks, runs, events }),
      }),
    },
    idempotency: new InMemoryIdempotencyStore(),
  });

  const sent: { target: ChatTarget; message: OutgoingMessage }[] = [];
  const bound: string[] = [];
  const session = new ChatSession({
    conversations,
    intent,
    dispatcher,
    access: { allowedUserIds, roleMap: {}, defaultRole: "developer" },
    send: async (target, message) => {
      sent.push({ target, message });
    },
    notifier: {
      bind: async (runId: string) => {
        bound.push(runId);
      },
    } as unknown as RunChatNotifier,
  });
  return { session, sent, bound, problems, tasks, runs, conversations };
}

const textOf = (message: OutgoingMessage): string =>
  [message.text ?? "", ...(message.blocks ?? []).map((block) => JSON.stringify(block))].join("\n");

describe("ChatSession", () => {
  it("turns a chat message into a command and replies with the business card", async () => {
    const intent = new StubIntentEngine({
      command: { type: "problem.create", payload: { title: "空状态", statement: "首页太空" } },
    });
    const { session, sent, problems } = await buildSession(intent);

    await session.handleEvent(event("om-1", "首页太空了"));

    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!.message)).toContain("prob-");
    expect(sent[0]!.target.receiveId).toBe("oc_chat");
    expect(await problems.listProblems()).toHaveLength(1);
  });

  it("never dispatches a retried message twice", async () => {
    const intent = new StubIntentEngine({
      command: { type: "problem.create", payload: { title: "t", statement: "s" } },
    });
    const { session, sent, problems } = await buildSession(intent);

    await session.handleEvent(event("om-1", "第一次"));
    await session.handleEvent(event("om-1", "第一次"));

    expect(await problems.listProblems()).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(intent.seen).toHaveLength(1);
  });

  it("refuses senders outside the allow-list", async () => {
    const intent = new StubIntentEngine({ command: undefined });
    const { session, sent } = await buildSession(intent, ["ou_someone_else"]);

    await session.handleEvent(event("om-1", "hello", "ou_stranger"));

    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!.message)).toContain("未授权");
    expect(intent.seen).toHaveLength(0);
  });

  it("answers with help when the message is not a command", async () => {
    const intent = new StubIntentEngine({ command: undefined });
    const { session, sent } = await buildSession(intent);

    await session.handleEvent(event("om-1", "你好"));

    expect(sent).toHaveLength(1);
    const reply = textOf(sent[0]!.message);
    expect(reply).toContain("我没理解成可执行的动作");
    // The "don't silently drop work" exit is mandatory for chat replies.
    expect(reply).toContain("如果刚才那句其实是要我做的事");
  });

  it("reports authorization rejections from the command layer", async () => {
    const intent = new StubIntentEngine({
      command: { type: "review.approve", payload: { taskId: "task-1" } },
    });
    const { session, sent } = await buildSession(intent);

    await session.handleEvent(event("om-1", "通过 task-1"));

    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!.message)).toContain("unauthorized");
  });

  it("binds a queued run to the conversation that started it", async () => {
    const intent = new StubIntentEngine({
      command: { type: "task.run", payload: { taskId: "task-1" } },
    });
    const { session, tasks, bound, sent } = await buildSession(intent);
    await tasks.createTask({
      id: "task-1",
      repositoryId: "repo-1",
      title: "Implement",
      acceptance: [],
      status: "READY",
      maxAttempts: 1,
    });

    await session.handleEvent(event("om-run", "运行 task-1"));

    expect(bound).toHaveLength(1);
    expect(textOf(sent[0]!.message)).toContain("queued");
  });

  it("ignores messages sent by the bot itself", async () => {
    const intent = new StubIntentEngine({ command: undefined });
    const { session, sent } = await buildSession(intent);
    const envelope = event("om-bot", "bot text");
    const sender = (envelope.event as { sender: { sender_type: string } }).sender;
    sender.sender_type = "app";

    await session.handleEvent(envelope);

    expect(sent).toHaveLength(0);
  });

  it("replies with an error when intent parsing fails", async () => {
    const intent: IntentEngine = {
      parse: vi.fn(async () => {
        throw new Error("provider down");
      }),
    };
    const { session, sent } = await buildSession(intent);

    await session.handleEvent(event("om-1", "hi"));

    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!.message)).toContain("provider down");
  });
});

describe("ChatSession config.apply", () => {
  it("sends the reply before restarting the service", async () => {
    const order: string[] = [];
    const conversations = new ConversationService(new InMemoryConversationStore());
    const dispatcher = new CommandDispatcher({
      handlers: {
        "config.apply": async () => ({
          pending: 1,
          message: { conversationId: "ignored", text: "🔄 正在重启服务" },
        }),
      },
      idempotency: new InMemoryIdempotencyStore(),
    });
    const session = new ChatSession({
      conversations,
      intent: new StubIntentEngine({ command: { type: "config.apply", payload: {} } }),
      dispatcher,
      access: { allowedUserIds: ["ou_dev"], roleMap: { ou_dev: "admin" }, defaultRole: "guest" },
      send: async () => {
        order.push("reply");
      },
      restartService: async () => {
        order.push("restart");
      },
    });

    await session.handleEvent(event("om-cfg", "重启服务"));

    expect(order).toEqual(["reply", "restart"]);
  });

  it("does not restart when nothing is pending", async () => {
    let restarted = 0;
    const dispatcher = new CommandDispatcher({
      handlers: { "config.apply": async () => ({ pending: 0 }) },
      idempotency: new InMemoryIdempotencyStore(),
    });
    const session = new ChatSession({
      conversations: new ConversationService(new InMemoryConversationStore()),
      intent: new StubIntentEngine({ command: { type: "config.apply", payload: {} } }),
      dispatcher,
      access: { allowedUserIds: ["ou_dev"], roleMap: { ou_dev: "admin" }, defaultRole: "guest" },
      send: async () => {},
      restartService: async () => {
        restarted += 1;
      },
    });

    await session.handleEvent(event("om-cfg2", "重启服务"));

    expect(restarted).toBe(0);
  });
});
