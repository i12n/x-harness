import { describe, expect, it } from "vitest";
import { parseCardAction } from "../src/channel/feishu/cardActions.js";
import { renderFeishuCard } from "../src/channel/feishu/cards.js";
import { CARD_CHOICE_TOGGLE, type MessageChoice, type OutgoingMessage } from "../src/channel/message.js";
import { CommandDispatcher } from "../src/command/dispatcher.js";
import { InMemoryIdempotencyStore } from "../src/command/idempotency.js";
import { ConversationService } from "../src/conversation/service.js";
import { CardRegistry } from "../src/server/cardRegistry.js";
import { ChatSession } from "../src/server/session.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";

const CLARIFICATION_ACTION = "problem.clarification.answer";

function choiceMessage(): OutgoingMessage {
  return {
    conversationId: "conv-1",
    blocks: [
      {
        type: "choice",
        id: "clar-1",
        options: [
          { id: "a", label: "选项 A" },
          { id: "b", label: "选项 B" },
        ],
        multi: true,
        submit: {
          action: CLARIFICATION_ACTION,
          label: "提交选择",
          payload: { problemId: "prob-1", clarificationId: "clar-1" },
        },
      },
    ],
  };
}

function click(
  actionId: string,
  value?: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    context: { open_message_id: "om-1", open_chat_id: "oc-1" },
    operator: { open_id: "ou_dev" },
    action: { tag: "button", value: { action: actionId, value } },
    ...overrides,
  };
}

async function buildSession() {
  const calls: Record<string, unknown>[] = [];
  const dispatcher = new CommandDispatcher({
    handlers: {
      [CLARIFICATION_ACTION]: async (payload) => {
        calls.push(payload);
        return {};
      },
    },
    idempotency: new InMemoryIdempotencyStore(),
  });
  const cards = new CardRegistry();
  const conversations = new ConversationService(new InMemoryConversationStore());
  const sent: OutgoingMessage[] = [];
  const session = new ChatSession({
    conversations,
    intent: { parse: async () => ({ command: undefined }) },
    dispatcher,
    access: { allowedUserIds: ["ou_dev"], roleMap: {}, defaultRole: "developer" },
    send: async (_target, message) => {
      sent.push(message);
    },
    cards,
  });
  return { session, cards, calls, sent };
}

describe("feishu card actions", () => {
  it("normalises a card.action.trigger body", () => {
    const parsed = parseCardAction(
      click(CARD_CHOICE_TOGGLE, JSON.stringify({ groupId: "clar-1", optionId: "a" })),
    );
    expect(parsed).toMatchObject({
      messageId: "om-1",
      chatId: "oc-1",
      operatorOpenId: "ou_dev",
      actionId: CARD_CHOICE_TOGGLE,
    });
    expect(JSON.parse(parsed!.value!)).toEqual({ groupId: "clar-1", optionId: "a" });
  });

  it("rejects a body it cannot route", () => {
    expect(parseCardAction({ action: { value: { action: "x" } } })).toBeUndefined();
    expect(parseCardAction(click("", undefined))).toBeUndefined();
  });
});

describe("card registry", () => {
  it("toggles multi-select options and renders the live selection", () => {
    const cards = new CardRegistry();
    cards.register("om-1", { conversationId: "conv-1", receiveId: "oc-1" }, choiceMessage());

    cards.toggle("om-1", "clar-1", "a", true);
    cards.toggle("om-1", "clar-1", "b", true);
    expect(cards.selection("om-1", "clar-1")).toEqual(["a", "b"]);

    const selected = cards.selectedMessage("om-1")!.blocks![0] as MessageChoice;
    expect(selected.selected).toEqual(["a", "b"]);

    cards.toggle("om-1", "clar-1", "a", true);
    expect(cards.selection("om-1", "clar-1")).toEqual(["b"]);
  });

  it("replaces the selection when the group is single-choice", () => {
    const cards = new CardRegistry();
    cards.register("om-1", { conversationId: "conv-1", receiveId: "oc-1" }, choiceMessage());
    cards.toggle("om-1", "clar-1", "a", false);
    cards.toggle("om-1", "clar-1", "b", false);
    expect(cards.selection("om-1", "clar-1")).toEqual(["b"]);
  });
});

describe("choice cards", () => {
  it("renders one toggle per option plus a submit button", () => {
    const card = renderFeishuCard(choiceMessage());
    const json = JSON.stringify(card);
    expect(json).toContain(CARD_CHOICE_TOGGLE);
    expect(json).toContain(CLARIFICATION_ACTION);
    expect(json).toContain("提交选择");
    expect(json).toContain("⬜ 选项 A");
  });

  it("marks selected options when re-rendered", () => {
    const message = choiceMessage();
    (message.blocks![0] as MessageChoice).selected = ["a"];
    expect(JSON.stringify(renderFeishuCard(message))).toContain("✅ 选项 A");
  });
});

describe("ChatSession card actions", () => {
  it("re-renders the card when an option is toggled", async () => {
    const { session, cards } = await buildSession();
    cards.register("om-1", { conversationId: "conv-1", receiveId: "oc-1" }, choiceMessage());

    const outcome = await session.handleCardAction({
      messageId: "om-1",
      chatId: "oc-1",
      operatorOpenId: "ou_dev",
      actionId: CARD_CHOICE_TOGGLE,
      value: JSON.stringify({ groupId: "clar-1", optionId: "a" }),
    });

    expect(outcome.deferred).toBeUndefined();
    const block = outcome.immediate.blocks![0] as MessageChoice;
    expect(block.selected).toEqual(["a"]);
  });

  it("submits every ticked option in one command after acknowledging", async () => {
    const { session, cards, calls, sent } = await buildSession();
    cards.register("om-1", { conversationId: "conv-1", receiveId: "oc-1" }, choiceMessage());
    cards.toggle("om-1", "clar-1", "a", true);
    cards.toggle("om-1", "clar-1", "b", true);

    const outcome = await session.handleCardAction({
      messageId: "om-1",
      chatId: "oc-1",
      operatorOpenId: "ou_dev",
      actionId: CLARIFICATION_ACTION,
      value: JSON.stringify({ problemId: "prob-1", clarificationId: "clar-1", groupId: "clar-1" }),
    });

    expect(outcome.immediate.text).toContain("已提交");
    expect(calls).toHaveLength(0);
    await outcome.deferred!();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      problemId: "prob-1",
      clarificationId: "clar-1",
      optionIds: ["a", "b"],
    });
    expect(sent).toHaveLength(1);
  });

  it("asks for a selection instead of submitting an empty one", async () => {
    const { session, cards, calls } = await buildSession();
    cards.register("om-1", { conversationId: "conv-1", receiveId: "oc-1" }, choiceMessage());

    const outcome = await session.handleCardAction({
      messageId: "om-1",
      chatId: "oc-1",
      operatorOpenId: "ou_dev",
      actionId: CLARIFICATION_ACTION,
      value: JSON.stringify({ problemId: "prob-1", clarificationId: "clar-1", groupId: "clar-1" }),
    });

    expect(outcome.immediate.text).toContain("请先勾选");
    expect(calls).toHaveLength(0);
  });

  it("returns an explanation card for a card it never registered", async () => {
    const { session } = await buildSession();
    const outcome = await session.handleCardAction({
      messageId: "om-old",
      chatId: "oc-1",
      operatorOpenId: "ou_dev",
      actionId: CARD_CHOICE_TOGGLE,
      value: JSON.stringify({ groupId: "clar-1", optionId: "a" }),
    });
    expect(outcome.immediate.text).toContain("失效");
  });

  it("refuses an operator outside the allow-list", async () => {
    const { session, cards, calls } = await buildSession();
    cards.register("om-1", { conversationId: "conv-1", receiveId: "oc-1" }, choiceMessage());
    const outcome = await session.handleCardAction({
      messageId: "om-1",
      chatId: "oc-1",
      operatorOpenId: "ou_stranger",
      actionId: CLARIFICATION_ACTION,
      value: JSON.stringify({ problemId: "prob-1", clarificationId: "clar-1", groupId: "clar-1" }),
    });
    expect(outcome.immediate.text).toContain("未授权");
    expect(outcome.deferred).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
