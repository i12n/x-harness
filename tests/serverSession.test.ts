import { describe, expect, it, vi } from "vitest";
import type { OutgoingMessage } from "../src/channel/message.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { createProblemCommandHandlers } from "../src/command/handlers/problem.js";
import { createReviewCommandHandlers } from "../src/command/handlers/review.js";
import { createTaskRunCommandHandlers } from "../src/command/handlers/taskRun.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import type { IntentEngine, IntentInput, IntentResult } from "../src/command/types.js";
import { ConversationService } from "../src/conversation/service.js";
import { HarnessError } from "../src/errors.js";
import { ScriptedProblemAnalyzer } from "../src/problem/application/analyzer.js";
import { ProblemService } from "../src/problem/application/service.js";
import { ConfirmationLoop } from "../src/problem/confirmationLoop.js";
import { ReviewService } from "../src/review/application/reviewService.js";
import { RunService } from "../src/run/application/runService.js";
import { TaskRunService } from "../src/run/application/taskRunService.js";
import type { ChatTarget, RunChatNotifier } from "../src/server/notifications.js";
import { ChatSession } from "../src/server/session.js";
import { createIntentTriage } from "../src/server/intentTriage.js";
import type { SpecificationBootstrap } from "../src/server/specificationBootstrap.js";
import { REQUIREMENT_NEXT_ACTION } from "../src/channel/rendering/requirement.js";
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

function event(
  messageId: string,
  text: string,
  openId = "ou_dev",
  threadId?: string,
): Record<string, unknown> {
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
        ...(threadId ? { thread_id: threadId } : {}),
      },
    },
  };
}

async function buildSession(
  intent: IntentEngine,
  allowedUserIds = ["ou_dev"],
  extra: Partial<ConstructorParameters<typeof ChatSession>[0]> = {},
) {
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
    // Caller overrides win (access, requirements, bootstrap…).
    ...extra,
  });
  return { session, sent, bound, problems, tasks, runs, conversations };
}

const textOf = (message: OutgoingMessage): string =>
  [message.text ?? "", ...(message.blocks ?? []).map((block) => JSON.stringify(block))].join("\n");

describe("ChatSession", () => {
  it("blames the model, not the repositories, when specification derivation fails", async () => {
    const intent = new StubIntentEngine({
      command: { type: "problem.confirm", payload: { problemId: "prob-stuck" } },
    });
    const { session, sent, problems } = await buildSession(intent, ["ou_dev"], {
      specificationBootstrap: {
        bootstrap: async () => {
          throw new HarnessError("chat completion returned empty content");
        },
      } as unknown as SpecificationBootstrap,
    });
    await problems.createProblem({
      id: "prob-stuck",
      title: "面包屑间距",
      statement: "分隔符前后各 16px",
      repositoryId: "repo-x",
    });
    await problems.updateProblemStatus("prob-stuck", "CONFIRMED");

    await session.handleEvent(event("om-boot", "确认"));

    const reply = textOf(sent.at(-1)!.message);
    expect(reply).toContain("无法生成规格");
    expect(reply).toContain("模型调用失败");
    expect(reply).not.toContain("没有可用的目标仓库");
  });

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

  // TASK-1243: replies land in the requirement's topic — anchored to the first
  // message, not to whatever message was just typed.
  it("anchors every reply to the conversation's first message", async () => {
    const intent = new StubIntentEngine({ command: undefined });
    const { session, sent } = await buildSession(intent);

    await session.handleEvent(event("om-1", "第一个问题"));
    await session.handleEvent(event("om-2", "追问一句"));

    const metadata = sent.map((entry) => entry.message.metadata ?? {});
    expect(metadata[0]?.replyToMessageId).toBe("om-1");
    expect(metadata[0]?.replyInThread).toBe(true);
    // The second reply does NOT anchor to om-2: same requirement, same topic.
    expect(metadata[1]?.replyToMessageId).toBe("om-1");
  });

  // TASK-1244: a user-level action is resolved against the conversation's
  // requirement — the user never names a task or a delivery.
  it("answers 看进展 with the requirement card, without ids", async () => {
    const intent = new StubIntentEngine({ command: undefined, action: { type: "show" } });
    const { session, sent } = await buildSession(intent, ["ou_dev"], {
      requirements: {
        resolve: async () => ({
          problemId: "prob-1",
          title: "面包屑分隔符间距",
          stage: "awaiting_release" as const,
          tasks: [],
        }),
      },
    });

    await session.handleEvent(event("om-1", "现在到哪一步了"));

    const reply = textOf(sent.at(-1)!.message);
    expect(reply).toContain("面包屑分隔符间距");
    expect(reply).toContain("待发布");
    expect(reply).not.toContain("dlv-");
    expect(reply).not.toContain("task-");
  });

  // TASK-1250: the fresh-start case — a chat with no requirement binding that
  // simply describes new work must open a requirement, not answer "I don't know
  // which one you mean".
  it("opens a requirement when the chat has none bound", async () => {
    const intent = new StubIntentEngine({
      command: undefined,
      action: { type: "create", payload: { statement: "面包屑间距改成 8px" } },
    });
    const { session, sent, problems } = await buildSession(intent, ["ou_dev"], {
      requirements: { resolve: async () => undefined },
    });

    await session.handleEvent(event("om-1", "面包屑间距改成 8px"));

    const created = await problems.listProblems();
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toContain("面包屑间距改成 8px");
    expect(textOf(sent.at(-1)!.message)).not.toContain("我还不知道你说的是哪件事");
  });

  // TASK-1257: the user-level `create` action must move the topic anchor too.
  // It reaches the same `problem.create` command as the legacy path but returns
  // through a helper, so the old re-anchor never ran for it — that is how a new
  // requirement kept the previous one's anchor and landed in its topic.
  it("moves the topic anchor to the message that asked for a new requirement", async () => {
    const intent = new StubIntentEngine({
      command: undefined,
      action: { type: "create", payload: { statement: "专辑页间距调整" } },
    });
    const { session, sent, conversations } = await buildSession(intent, ["ou_dev"], {
      requirements: { resolve: async () => undefined },
    });

    await session.handleEvent(event("om-1", "第一个需求"));
    await session.handleEvent(event("om-2", "再做一个：专辑页间距调整"));

    const conversation = await conversations.findByExternal({
      channel: "feishu",
      externalChatId: "oc_chat",
    });
    expect(conversation?.anchorMessageId).toBe("om-2");
    // The reply for the new requirement lands in its own topic, not the old one.
    expect(sent.at(-1)!.message.metadata?.replyToMessageId).toBe("om-2");
  });

  // TASK-1261: when creating the requirement fails (model output, store error…)
  // the reply must still open the topic of *this* message — a failure landing in
  // the previous requirement's thread is what made the bot look like it ignored
  // the new one.
  it("opens the new topic even when creating the requirement fails", async () => {
    const dispatcher = new CommandDispatcher({
      handlers: {
        "problem.create": async () => {
          throw new Error("problem analyzer returned no valid JSON");
        },
      },
      idempotency: new InMemoryIdempotencyStore(),
    });
    const intent = new StubIntentEngine({
      command: undefined,
      action: { type: "create", payload: { statement: "加下载按钮" } },
    });
    const { session, sent } = await buildSession(intent, ["ou_dev"], {
      dispatcher,
      requirements: { resolve: async () => undefined, resolveByProblemId: async () => undefined },
    });

    await session.handleEvent(event("om-1", "第一个需求"));
    await session.handleEvent(event("om-2", "再加一个：下载按钮"));

    const last = sent.at(-1)!.message;
    expect(textOf(last)).toContain("problem.create");
    expect(last.metadata?.replyToMessageId).toBe("om-2");
  });

  // TASK-1257: never open a new requirement inside someone else's topic.
  it("refuses to open a new requirement inside another requirement's topic", async () => {
    const intent = new StubIntentEngine({
      command: undefined,
      action: { type: "create", payload: { statement: "把专辑页间距也改一下" } },
    });
    const { session, sent, problems } = await buildSession(intent, ["ou_dev"], {
      requirements: {
        resolve: async () => ({
          problemId: "prob-1",
          title: "面包屑分隔符间距",
          stage: "developing" as const,
          tasks: [],
        }),
      },
    });

    await session.handleEvent(
      event("om-1", "把专辑页间距也改一下", "ou_dev", "omt_topic_1"),
    );

    expect(await problems.listProblems()).toHaveLength(0);
    const reply = textOf(sent.at(-1)!.message);
    expect(reply).toContain("新需求");
    expect(reply).toContain("面包屑分隔符间距");
  });

  // TASK-1259: prob-… is the user-facing handle — it wins over whatever the
  // conversation happens to be about.
  it("resolves a prob-… id in the message instead of the conversation binding", async () => {
    const seenIds: string[] = [];
    const intent = new StubIntentEngine({ command: undefined, action: { type: "show" } });
    const { session, sent } = await buildSession(intent, ["ou_dev"], {
      triage: createIntentTriage({ engine: intent }),
      requirements: {
        resolve: async () => {
          throw new Error("the conversation binding must not be used");
        },
        resolveByProblemId: async (id) => {
          seenIds.push(id);
          return {
            problemId: id,
            title: "专辑页「播放全部」间距",
            stage: "awaiting_release" as const,
            tasks: [],
            delivery: {
              id: "dlv-9",
              specificationId: "spec-9",
              status: "READY_FOR_RELEASE",
            } as never,
          };
        },
      },
    });

    await session.handleEvent(event("om-1", "prob-950662cc5b 现在到哪一步了"));

    expect(seenIds).toEqual(["prob-950662cc5b"]);
    const reply = textOf(sent.at(-1)!.message);
    expect(reply).toContain("专辑页「播放全部」间距");
    expect(reply).toContain("按你点名的 prob-950662cc5b");
  });

  // TASK-1259: the card's "next step" buttons run the same action pipeline as
  // typing it — including the role check.
  it("runs a stage action from a card button", async () => {
    const seen: Record<string, unknown>[] = [];
    const dispatcher = new CommandDispatcher({
      handlers: {
        "deploy.test": async (payload) => {
          seen.push(payload);
          return { message: { conversationId: "x", text: "🚀 已开始测试部署" } };
        },
      },
      idempotency: new InMemoryIdempotencyStore(),
    });
    const intent = new StubIntentEngine({ command: undefined });
    const { session, sent } = await buildSession(intent, ["ou_reviewer"], {
      dispatcher,
      access: {
        allowedUserIds: ["ou_reviewer"],
        roleMap: { ou_reviewer: "reviewer" },
        defaultRole: "developer",
      },
      requirements: {
        resolve: async () => undefined,
        resolveByProblemId: async (id) => ({
          problemId: id,
          title: "专辑页「播放全部」间距",
          stage: "awaiting_acceptance" as const,
          tasks: [],
          delivery: {
            id: "dlv-9",
            specificationId: "spec-9",
            status: "IN_PROGRESS",
          } as never,
        }),
      },
    });

    const outcome = await session.handleCardAction({
      messageId: "om-card",
      chatId: "oc_chat",
      operatorOpenId: "ou_reviewer",
      actionId: REQUIREMENT_NEXT_ACTION,
      value: JSON.stringify({
        requirementId: "prob-9",
        action: "deploy",
        stage: "awaiting_acceptance",
      }),
    });
    await outcome.deferred?.();

    expect(seen).toEqual([{ deliveryId: "dlv-9" }]);
    expect(textOf(sent.at(-1)!.message)).toContain("测试部署");
  });

  it("refuses a card button the sender's role cannot use", async () => {
    const seen: unknown[] = [];
    const dispatcher = new CommandDispatcher({
      handlers: {
        "deploy.promote": async (payload) => {
          seen.push(payload);
          return { message: { conversationId: "x", text: "已合并" } };
        },
      },
      idempotency: new InMemoryIdempotencyStore(),
    });
    const intent = new StubIntentEngine({ command: undefined });
    const { session, sent } = await buildSession(intent, ["ou_dev"], {
      dispatcher,
      requirements: {
        resolve: async () => undefined,
        resolveByProblemId: async (id) => ({
          problemId: id,
          title: "专辑页「播放全部」间距",
          stage: "awaiting_release" as const,
          tasks: [],
          delivery: {
            id: "dlv-9",
            specificationId: "spec-9",
            status: "READY_FOR_RELEASE",
          } as never,
        }),
      },
    });

    const outcome = await session.handleCardAction({
      messageId: "om-card",
      chatId: "oc_chat",
      operatorOpenId: "ou_dev",
      actionId: REQUIREMENT_NEXT_ACTION,
      value: JSON.stringify({
        requirementId: "prob-9",
        action: "publish",
        stage: "awaiting_release",
      }),
    });
    await outcome.deferred?.();

    expect(seen).toEqual([]);
    expect(textOf(sent.at(-1)!.message)).toContain("deploy.promote");
  });

  // TASK-1252: "开始做吧 / 重试生成规格" on a confirmed requirement whose
  // derivation failed must advance it (re-run the bootstrap), not say "nothing
  // to re-run".
  it("advances a confirmed requirement through the bootstrap", async () => {
    const intent = new StubIntentEngine({
      command: undefined,
      action: { type: "rerun" },
    });
    let bootstrapped: string | undefined;
    const { session, sent } = await buildSession(intent, ["ou_dev"], {
      requirements: {
        resolve: async () => ({
          problemId: "prob-1",
          title: "面包屑间距 8px",
          stage: "clarifying" as const,
          tasks: [],
        }),
      },
      specificationBootstrap: {
        bootstrap: async (problemId: string) => {
          bootstrapped = problemId;
          return {
            specification: { id: "spec-1", acceptance: [], title: "面包屑间距 8px" },
            tasks: [{ id: "task-spec-1-0", title: "改间距" }],
            replayed: false,
            unknownTargets: [],
          };
        },
      } as unknown as SpecificationBootstrap,
    });

    await session.handleEvent(event("om-1", "开始做吧"));

    expect(bootstrapped).toBe("prob-1");
    expect(textOf(sent.at(-1)!.message)).toContain("规格已就绪");
  });

  it("打回 reworks the finished deliverable and ignores a pasted id", async () => {
    const intent = new StubIntentEngine({
      command: undefined,
      action: { type: "reject", payload: { feedback: "间距应该是 24px" } },
    });
    const { session, sent, tasks } = await buildSession(intent, ["ou_dev"], {
      // 打回 is reviewer/admin work — the role check is unchanged.
      access: { allowedUserIds: ["ou_dev"], roleMap: { ou_dev: "admin" }, defaultRole: "developer" },
      requirements: {
        resolve: async () => ({
          title: "面包屑分隔符间距",
          stage: "awaiting_release" as const,
          tasks: [
            {
              id: "task-spec-1-0",
              repositoryId: "repo-1",
              targets: [],
              title: "给 sep 加 16px",
              description: "",
              status: "DONE",
              priority: 50,
              acceptance: [],
              constraints: {},
              maxAttempts: 3,
              createdAt: "",
              updatedAt: "",
            },
          ],
        }),
      },
    });
    await tasks.createTask({
      id: "task-spec-1-0",
      repositoryId: "repo-1",
      title: "给 sep 加 16px",
      status: "DONE",
    });

    await session.handleEvent(event("om-9", "打回 task-spec-1-0，间距应该是 24px"));

    const task = await tasks.findTask("task-spec-1-0");
    expect(task.status).toBe("READY");
    const reply = textOf(sent.at(-1)!.message);
    expect(reply).toContain("编号我忽略了");
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

  // TASK-1260: an unreadable message used to be dropped silently, which read as
  // "the bot is dead". Answer once instead.
  it("answers an unreadable message instead of staying silent", async () => {
    const intent = new StubIntentEngine({ command: undefined });
    const { session, sent } = await buildSession(intent);

    await session.handleEvent({
      schema: "2.0",
      header: { event_id: "evt-img", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_dev" }, sender_type: "user" },
        message: {
          message_id: "om-img",
          chat_id: "oc_chat",
          chat_type: "p2p",
          message_type: "image",
          create_time: "1758240000000",
          content: JSON.stringify({ image_key: "img_v2_1" }),
        },
      },
    });

    expect(textOf(sent.at(-1)!.message)).toContain("只认纯文字");
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
