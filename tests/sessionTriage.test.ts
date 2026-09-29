import { describe, expect, it, vi } from "vitest";
import type { OutgoingMessage } from "../src/channel/message.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import { createProblemCommandHandlers } from "../src/command/handlers/problem.js";
import type { IntentEngine, IntentInput, IntentResult } from "../src/command/types.js";
import { ConversationService } from "../src/conversation/service.js";
import { ScriptedProblemAnalyzer } from "../src/problem/application/analyzer.js";
import { ProblemService } from "../src/problem/application/service.js";
import { ConfirmationLoop } from "../src/problem/confirmationLoop.js";
import { createIntentTriage } from "../src/server/intentTriage.js";
import { ChatSession } from "../src/server/session.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";

function event(messageId: string, text: string): Record<string, unknown> {
  return {
    header: { event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_admin" }, sender_type: "user" },
      message: {
        message_id: messageId,
        chat_id: "oc_p2p",
        chat_type: "p2p",
        message_type: "text",
        create_time: "1758240000000",
        content: JSON.stringify({ text }),
      },
    },
  };
}

class StubEngine implements IntentEngine {
  constructor(public result: IntentResult) {}
  async parse(_input: IntentInput): Promise<IntentResult> {
    return this.result;
  }
}

async function build(engineResult: IntentResult, options: { withRules?: boolean } = {}) {
  const problems = new InMemoryProblemStore();
  const conversations = new ConversationService(new InMemoryConversationStore());
  const events = new InMemoryEventStore();
  const engine = new StubEngine(engineResult);
  const sent: OutgoingMessage[] = [];

  const problemService = new ProblemService(
    problems,
    new ConfirmationLoop({
      problems,
      events,
      analyzer: new ScriptedProblemAnalyzer({
        summary: "clear",
        needsInput: false,
        uncertainties: [],
        clarifications: [],
      }),
    }),
  );
  const session = new ChatSession({
    conversations,
    intent: engine,
    triage: createIntentTriage({ engine, rules: options.withRules !== false }),
    dispatcher: new CommandDispatcher({
      handlers: createProblemCommandHandlers({ problems: problemService, conversations }),
      idempotency: new InMemoryIdempotencyStore(),
    }),
    access: { allowedUserIds: ["ou_admin"], roleMap: { ou_admin: "admin" }, defaultRole: "guest" },
    send: async (_target, message) => {
      sent.push(message);
    },
    recordEvent: async (type, payload) => {
      await events.record({ type, payload });
    },
  });
  return { session, sent, problems, events };
}

const textOf = (message: OutgoingMessage): string =>
  [message.text ?? "", ...(message.blocks ?? []).map((block) => JSON.stringify(block))].join("\n");

describe("work confirmation round-trip", () => {
  it("asks before creating anything when the verdict is uncertain", async () => {
    const { session, sent, problems, events } = await build({
      command: { type: "problem.create", payload: { title: "优化", statement: "优化一下首页" } },
      kind: "work",
      confidence: 0.4,
      reason: "不确定是要我做还是只问问",
    });

    await session.handleEvent(event("om-1", "优化一下首页"));

    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!)).toContain("这是要我开工，还是只想了解情况");
    // Nothing was created and nothing was started.
    expect(await problems.listProblems()).toHaveLength(0);
    const classified = await events.listEvents({ type: "intent.classified" });
    expect(classified).toHaveLength(1);
    expect(classified[0]!.payload).toMatchObject({ kind: "work", needsConfirmation: true });
  });

  it("creates the problem when the user answers 开工", async () => {
    const { session, sent, problems } = await build({
      command: { type: "problem.create", payload: { title: "优化", statement: "优化一下首页" } },
      kind: "work",
      confidence: 0.4,
    });

    await session.handleEvent(event("om-1", "优化一下首页，把首屏加载也一起看下"));
    await session.handleEvent(event("om-2", "开工"));

    const created = await problems.listProblems();
    expect(created).toHaveLength(1);
    // The original sentence — not the word 开工 — becomes the statement.
    expect(created[0]!.statement).toContain("优化一下首页");
    expect(textOf(sent[1]!)).toContain("按这句开工");
  });

  it("does nothing when the user answers 只是问问", async () => {
    const { session, sent, problems } = await build({
      command: { type: "problem.create", payload: { title: "优化", statement: "优化一下首页" } },
      kind: "work",
      confidence: 0.4,
    });

    await session.handleEvent(event("om-1", "优化一下首页"));
    await session.handleEvent(event("om-2", "只是问问"));

    expect(await problems.listProblems()).toHaveLength(0);
    expect(textOf(sent[1]!)).toContain("那我不动手");
  });

  it("clears the pending request once answered", async () => {
    const { session, problems } = await build({
      command: { type: "problem.create", payload: { title: "优化", statement: "优化一下首页" } },
      kind: "work",
      confidence: 0.4,
    });

    await session.handleEvent(event("om-1", "优化一下首页"));
    await session.handleEvent(event("om-2", "只是问问"));
    await session.handleEvent(event("om-3", "开工"));

    // The second 开工 has nothing pending, so it is not silently replayed.
    expect(await problems.listProblems()).toHaveLength(0);
  });
});

describe("act and query paths", () => {
  it("dispatches a query command without asking for confirmation", async () => {
    const { session, sent } = await build({
      command: { type: "task.list", payload: {} },
      kind: "query",
      confidence: 0.95,
    });

    await session.handleEvent(event("om-1", "现在有几个任务"));

    expect(sent).toHaveLength(1);
    // This harness wires only the problem handlers, so the dispatcher reports
    // "no handler" — the point is that the query was NOT turned into a work
    // confirmation and no problem was created.
    expect(textOf(sent[0]!)).not.toContain("这是要我开工");
    expect(textOf(sent[0]!)).toContain("task.list");
  });

  it("sends the mandatory exit when the message is neither", async () => {
    const { session, sent } = await build({ command: undefined, kind: "chat", confidence: 0.9 });

    await session.handleEvent(event("om-1", "你好"));

    expect(textOf(sent[0]!)).toContain("如果刚才那句其实是要我做的事");
  });
});

describe("audit trail", () => {
  it("records every classification with its stage and confidence", async () => {
    const { session, events } = await build({ command: undefined, kind: "chat", confidence: 0.9 });
    const spy = vi.spyOn(events, "record");

    await session.handleEvent(event("om-1", "你好"));

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "intent.classified",
        payload: expect.objectContaining({ kind: "chat", stage: "model" }),
      }),
    );
  });
});
