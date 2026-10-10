import { describe, expect, it } from "vitest";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import type { IntentEngine } from "../src/command/types.js";
import { ConversationService } from "../src/conversation/service.js";
import {
  PROBLEM_ANSWER_ALL_ACTION,
  renderProblemMessage,
} from "../src/channel/rendering/problem.js";
import type { OutgoingMessage } from "../src/channel/message.js";
import { ChatSession } from "../src/server/session.js";
import { CardRegistry } from "../src/server/cardRegistry.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";

const problem = {
  id: "prob-e99be828e2",
  title: "x-music 添加下载歌曲功能",
  statement: "歌曲列表加下载按钮；不支持整专辑下载",
  status: "NEEDS_INPUT",
} as never;

function clarification(id: string, question: string, options: string[]) {
  return {
    id,
    problemId: "prob-e99be828e2",
    question,
    type: "single_choice",
    required: true,
    status: "OPEN",
    options: options.map((label, index) => ({ id: `${id}-o${index}`, label })),
  } as never;
}

const clarifications = [
  clarification("clar-a", "下载功能做到什么程度？", ["仅需按钮", "带进度", "完整管理"]),
  clarification("clar-b", "如何决定音质与保存位置？", ["默认自动", "每次弹窗"]),
];

function textOf(message: OutgoingMessage): string {
  return [
    message.text ?? "",
    ...(message.blocks ?? []).flatMap((block) =>
      block.type === "markdown" || block.type === "text" || block.type === "section"
        ? [block.text ?? ""]
        : block.type === "choice"
          ? [`${block.title ?? ""} ${block.options.map((o) => o.label).join("/")}`]
          : block.type === "actions"
            ? block.actions.map((action) => `[${action.label}]`)
            : [],
    ),
  ].join("\n");
}

describe("clarification form (TASK-1266)", () => {
  it("renders every question as a toggle group with one shared submit", () => {
    const card = renderProblemMessage(problem, { needsInput: true, clarifications });
    const choices = (card.blocks ?? []).filter((block) => block.type === "choice");
    expect(choices).toHaveLength(2);
    for (const choice of choices) {
      expect(choice.type === "choice" && choice.submit).toBeUndefined();
      expect(choice.type === "choice" && choice.title).toContain("？");
    }
    const actions = (card.blocks ?? []).filter((block) => block.type === "actions");
    expect(actions).toHaveLength(1);
    expect(JSON.stringify(actions)).toContain(PROBLEM_ANSWER_ALL_ACTION);
    expect(textOf(card)).toContain("提交全部答案");
    expect(textOf(card)).toContain("还剩 2 项");
  });

  it("records answered questions in one line instead of printing them again", () => {
    const card = renderProblemMessage(problem, {
      needsInput: true,
      clarifications: [clarifications[1]!],
      answered: [{ question: "下载功能做到什么程度？", answer: "仅需按钮" }],
    });
    expect(textOf(card)).toContain("还剩 1 项");
    expect(textOf(card)).toContain("✅ 已确认 1 项：下载功能做到什么程度？=仅需按钮");
    expect(textOf(card)).not.toContain("仅需按钮/带进度");
  });
});

class NoopIntent implements IntentEngine {
  async parse() {
    return { command: undefined };
  }
}

async function buildSession() {
  const dispatched: { type: string; payload: Record<string, unknown> }[] = [];
  const dispatcher = new CommandDispatcher({
    handlers: {
      "problem.clarification.answer": async (payload) => {
        dispatched.push({ type: "problem.clarification.answer", payload });
        // The real path re-checks the problem; the last answer closes the form.
        const last = payload.clarificationId === "clar-b";
        return {
          problem: { ...(problem as object), status: last ? "CONFIRMED" : "ANSWERED" },
          needsInput: !last,
          clarifications: last ? [] : [],
        };
      },
    },
    idempotency: new InMemoryIdempotencyStore(),
  });
  const conversations = new ConversationService(new InMemoryConversationStore());
  const cards = new CardRegistry();
  const sent: OutgoingMessage[] = [];
  const session = new ChatSession({
    conversations,
    intent: new NoopIntent(),
    dispatcher,
    access: { allowedUserIds: ["ou_dev"], roleMap: {}, defaultRole: "developer" },
    send: async (_target, message) => {
      sent.push(message);
    },
    cards,
  });
  return { session, cards, sent, dispatched };
}

describe("submitting the clarification form", () => {
  it("answers every ticked group in one click and drops them from the card", async () => {
    const { session, cards, dispatched } = await buildSession();
    const card = renderProblemMessage(problem, { needsInput: true, clarifications });
    cards.register("om-card", { conversationId: "conv-1", receiveId: "oc_1" }, card);
    cards.toggle("om-card", "clar-a", "clar-a-o0", true);
    cards.toggle("om-card", "clar-b", "clar-b-o0", true);

    const outcome = await session.handleCardAction({
      messageId: "om-card",
      chatId: "oc_1",
      operatorOpenId: "ou_dev",
      actionId: PROBLEM_ANSWER_ALL_ACTION,
      value: JSON.stringify({ problemId: "prob-e99be828e2" }),
    });

    // The card the user sees next keeps the record, not the questions.
    const text = textOf(outcome.immediate);
    expect(text).toContain("✅ 已确认 2 项");
    expect(text).not.toContain("下载功能做到什么程度？**");
    expect((outcome.immediate.blocks ?? []).some((block) => block.type === "choice")).toBe(false);

    await outcome.deferred?.();
    expect(dispatched.map((entry) => entry.payload.clarificationId)).toEqual([
      "clar-a",
      "clar-b",
    ]);
    expect(dispatched[0]!.payload.optionIds).toEqual(["clar-a-o0"]);
  });

  it("keeps the questions that were not ticked", async () => {
    const { session, cards } = await buildSession();
    const card = renderProblemMessage(problem, { needsInput: true, clarifications });
    cards.register("om-card", { conversationId: "conv-1", receiveId: "oc_1" }, card);
    cards.toggle("om-card", "clar-a", "clar-a-o0", true);

    const outcome = await session.handleCardAction({
      messageId: "om-card",
      chatId: "oc_1",
      operatorOpenId: "ou_dev",
      actionId: PROBLEM_ANSWER_ALL_ACTION,
      value: JSON.stringify({ problemId: "prob-e99be828e2" }),
    });

    const choices = (outcome.immediate.blocks ?? []).filter((block) => block.type === "choice");
    expect(choices).toHaveLength(1);
    expect(textOf(outcome.immediate)).toContain("还剩 1 项");
    expect(textOf(outcome.immediate)).toContain("✅ 已确认 1 项");
  });

  it("asks for a selection when nothing was ticked", async () => {
    const { session, cards, dispatched } = await buildSession();
    cards.register(
      "om-card",
      { conversationId: "conv-1", receiveId: "oc_1" },
      renderProblemMessage(problem, { needsInput: true, clarifications }),
    );

    const outcome = await session.handleCardAction({
      messageId: "om-card",
      chatId: "oc_1",
      operatorOpenId: "ou_dev",
      actionId: PROBLEM_ANSWER_ALL_ACTION,
      value: JSON.stringify({ problemId: "prob-e99be828e2" }),
    });

    expect(textOf(outcome.immediate)).toContain("还没有勾选任何选项");
    expect(dispatched).toEqual([]);
  });
});
