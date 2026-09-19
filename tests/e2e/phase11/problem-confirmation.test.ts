import { afterEach, describe, expect, it } from "vitest";
import { renderProblemMessage } from "../../../src/channel/rendering/problem.js";
import {
  createPhase11Harness,
  needsInputAnalysis,
  SUFFICIENT_ANALYSIS,
} from "./harness.js";

describe("Phase 11 E2E — problem confirmation", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("turns a message into a Problem, a clarification and an OutgoingMessage", async () => {
    const h = await createPhase11Harness({
      analyses: [needsInputAnalysis(), SUFFICIENT_ANALYSIS],
    });
    cleanups.push(h.cleanup);
    const bootstrapped = await h.conversations.handleIncoming({
      channel: "cli",
      externalChatId: "chat-1",
      messageId: "bootstrap",
      senderId: "cli-user",
      text: "hello",
      timestamp: new Date(),
    });

    const created = await h.dispatchCommand({
      conversationId: bootstrapped.conversation.id,
      messageId: "msg-create",
      command: {
        type: "problem.create",
        payload: {
          title: "Add greet",
          statement: "Add a greet(name) function to the sample project.",
        },
      },
      roles: ["guest"],
    });

    expect(created.status).toBe("succeeded");
    const data = created.data as {
      problem: { id: string; status: string };
      clarifications: { id: string; options: { id: string }[] }[];
    };
    expect(data.problem.status).toBe("NEEDS_INPUT");
    expect(data.clarifications).toHaveLength(1);

    const conversation = await h.conversations.findConversation(
      bootstrapped.conversation.id,
    );
    expect(conversation.subjectType).toBe("problem");
    expect(conversation.subjectId).toBe(data.problem.id);

    const problem = await h.problemStore.findProblem(data.problem.id);
    const rendered = renderProblemMessage(problem, {
      needsInput: true,
      clarifications: await h.problemStore.listClarifications(problem.id),
    });
    const text = JSON.stringify(rendered.blocks);
    expect(text).toContain("All users");
    expect(text).toContain("problem.clarification.answer");

    const answered = await h.dispatchCommand({
      conversationId: bootstrapped.conversation.id,
      messageId: "msg-answer",
      command: {
        type: "problem.clarification.answer",
        payload: {
          problemId: problem.id,
          clarificationId: data.clarifications[0]!.id,
          optionId: "all_users",
        },
      },
      roles: ["guest"],
    });
    expect(answered.status).toBe("succeeded");
    expect((answered.data as { problem: { status: string } }).problem.status).toBe(
      "CONFIRMED",
    );
  });

  it("re-analyzes when the answer is insufficient and rejects cross-problem answers", async () => {
    const h = await createPhase11Harness({
      analyses: [needsInputAnalysis("Question A?"), needsInputAnalysis("Question B?")],
    });
    cleanups.push(h.cleanup);

    const first = await h.dispatchCommand({
      messageId: "msg-a",
      command: {
        type: "problem.create",
        payload: { title: "A", statement: "A" },
      },
      roles: ["guest"],
    });
    const second = await h.dispatchCommand({
      messageId: "msg-b",
      command: {
        type: "problem.create",
        payload: { title: "B", statement: "B" },
      },
      roles: ["guest"],
    });
    const problemA = (first.data as { problem: { id: string } }).problem.id;
    const clarificationA = (first.data as { clarifications: { id: string }[] })
      .clarifications[0]!.id;
    const problemB = (second.data as { problem: { id: string } }).problem.id;

    const answered = await h.dispatchCommand({
      messageId: "msg-answer",
      command: {
        type: "problem.clarification.answer",
        payload: { problemId: problemA, clarificationId: clarificationA, optionId: "all_users" },
      },
      roles: ["guest"],
    });
    expect((answered.data as { problem: { status: string } }).problem.status).toBe(
      "NEEDS_INPUT",
    );

    const crossProblem = await h.dispatchCommand({
      messageId: "msg-cross",
      command: {
        type: "problem.clarification.answer",
        payload: { problemId: problemB, clarificationId: clarificationA, optionId: "all_users" },
      },
      roles: ["guest"],
    });
    expect(crossProblem).toMatchObject({
      status: "rejected",
      error: { code: "invalid_clarification" },
    });
  });

  it("rejects problem.confirm while a clarification is open", async () => {
    const h = await createPhase11Harness({ analyses: [needsInputAnalysis()] });
    cleanups.push(h.cleanup);
    const created = await h.dispatchCommand({
      messageId: "msg-create",
      command: {
        type: "problem.create",
        payload: { title: "A", statement: "A" },
      },
      roles: ["guest"],
    });
    const problemId = (created.data as { problem: { id: string } }).problem.id;

    const confirmed = await h.dispatchCommand({
      messageId: "msg-confirm",
      command: { type: "problem.confirm", payload: { problemId } },
      roles: ["developer"],
    });

    expect(confirmed).toMatchObject({
      status: "rejected",
      error: { code: "required_clarification_pending" },
    });
  });
});
