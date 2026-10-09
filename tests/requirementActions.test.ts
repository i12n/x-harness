import { describe, expect, it } from "vitest";
import { normalizeIntent } from "../src/command/llmIntentEngine.js";
import { commandsForRequirementAction } from "../src/requirement/application/actions.js";
import { createRequirementResolver } from "../src/requirement/application/resolver.js";
import type { RequirementView } from "../src/requirement/application/resolver.js";
import { InMemoryConversationStore } from "../src/store/inMemoryConversationStore.js";
import { InMemoryDeliveryStore } from "../src/store/inMemoryDeliveryStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemoryRunStore } from "../src/store/inMemoryRunStore.js";
import { InMemorySpecificationPlanStore } from "../src/store/inMemorySpecificationPlanStore.js";
import { InMemorySpecificationStore } from "../src/store/inMemorySpecificationStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

/**
 * TASK-1244: the chat speaks user-level actions; the harness maps them onto
 * whichever internal object the conversation is about.
 */
async function harness(
  options: {
    tasks?: { id: string; status: string }[];
    delivery?: string;
    /** Bind the conversation to the problem instead of its first task. */
    bound?: "task" | "problem";
  } = {},
) {
  const tasks = new InMemoryTaskStore();
  const specifications = new InMemorySpecificationStore();
  const plans = new InMemorySpecificationPlanStore();
  const deliveries = new InMemoryDeliveryStore();
  const problems = new InMemoryProblemStore();
  const conversations = new InMemoryConversationStore();
  const runs = new InMemoryRunStore();

  await problems.createProblem({
    id: "prob-1",
    title: "面包屑分隔符间距",
    statement: "前后各 16px",
  });
  await problems.updateProblemStatus("prob-1", "CONFIRMED");
  await specifications.createSpecification({
    id: "spec-1",
    problemId: "prob-1",
    title: "面包屑分隔符间距",
  });
  const taskSpecs = options.tasks ?? [{ id: "task-spec-1-0", status: "DONE" }];
  for (const [index, entry] of taskSpecs.entries()) {
    await tasks.createTask({
      id: entry.id,
      repositoryId: "repo-1",
      title: `开发点 ${index + 1}`,
      status: entry.status as never,
    });
    await plans.createPlanItem({
      specificationId: "spec-1",
      position: index,
      title: `开发点 ${index + 1}`,
      taskId: entry.id,
    });
  }
  // Mirrors the reconciler: an unfinished task means the delivery is in progress.
  const derivedStatus = taskSpecs.every((task) => task.status === "DONE")
    ? "READY_FOR_RELEASE"
    : "IN_PROGRESS";
  await deliveries.createDelivery({
    id: "dlv-1",
    specificationId: "spec-1",
    status: derivedStatus,
  });
  if (options.delivery) {
    await deliveries.updateDeliveryStatus("dlv-1", options.delivery as never);
  }
  await conversations.createConversation({
    id: "conv-1",
    channel: "feishu",
    externalChatId: "chat-1",
    subjectType: options.bound === "problem" ? "problem" : "task",
    subjectId: options.bound === "problem" ? "prob-1" : taskSpecs[0]!.id,
  });

  const resolver = createRequirementResolver({
    conversations,
    problems,
    specifications,
    deliveries,
    plans,
    runs,
    tasks,
  });
  const view = (await resolver.resolve("conv-1")) as RequirementView;
  return { resolver, view };
}

describe("requirement resolver (TASK-1244)", () => {
  it("maps a task-bound conversation to the whole requirement", async () => {
    const { view } = await harness();

    expect(view.problemId).toBe("prob-1");
    expect(view.title).toBe("面包屑分隔符间距");
    expect(view.delivery?.id).toBe("dlv-1");
    expect(view.tasks.map((task) => task.id)).toEqual(["task-spec-1-0"]);
    expect(view.boundTask?.id).toBe("task-spec-1-0");
  });

  it("derives the stage the user sees", async () => {
    expect((await harness()).view.stage).toBe("awaiting_release");
    expect((await harness({ delivery: "RELEASED" })).view.stage).toBe("released");
    expect(
      (await harness({ tasks: [{ id: "task-spec-1-0", status: "RUNNING" }] })).view.stage,
    ).toBe("developing");
  });

  it("returns nothing for a conversation without a requirement", async () => {
    const { resolver } = await harness();
    expect(await resolver.resolve("conv-missing")).toBeUndefined();
  });
});

describe("action → command mapping (TASK-1244)", () => {
  it("answers 看进展 with the card, never with ids", async () => {
    const { view } = await harness();
    expect(commandsForRequirementAction({ type: "show" }, view)).toMatchObject({
      commands: [],
      showCard: true,
    });
  });

  it("打回 becomes a rework of the finished deliverable, with the user's words", async () => {
    const { view } = await harness();
    const outcome = commandsForRequirementAction(
      { type: "reject", payload: { feedback: "间距应该是 24px" } },
      view,
    );

    expect(outcome.commands).toEqual([
      {
        type: "review.request_changes",
        payload: { taskId: "task-spec-1-0", feedback: "间距应该是 24px" },
      },
    ]);
  });

  // TASK-1249: the review stage is the classic moment to reject, and a task that
  // ran out of attempts is reopenable by a human too.
  it("打回 also targets a deliverable waiting for review", async () => {
    const { view } = await harness({
      tasks: [
        { id: "task-spec-1-0", status: "REVIEW" },
        { id: "task-spec-1-1", status: "BLOCKED" },
      ],
      delivery: "IN_PROGRESS",
    });
    const outcome = commandsForRequirementAction(
      { type: "reject", payload: { feedback: "还是 8px 不对" } },
      view,
    );

    expect(outcome.commands).toEqual([
      {
        type: "review.request_changes",
        payload: { taskId: "task-spec-1-0", feedback: "还是 8px 不对" },
      },
    ]);
  });

  it("says it is still running instead of pretending it cannot be rejected", async () => {
    const { view } = await harness({
      tasks: [{ id: "task-spec-1-0", status: "RUNNING" }],
      delivery: "IN_PROGRESS",
    });
    const outcome = commandsForRequirementAction({ type: "reject" }, view);
    expect(outcome.commands).toHaveLength(0);
    expect(outcome.ask).toContain("还在跑");
  });

  it("asks which deliverable to redo when the requirement has several", async () => {
    const { view } = await harness({
      tasks: [
        { id: "task-spec-1-0", status: "DONE" },
        { id: "task-spec-1-1", status: "DONE" },
      ],
      bound: "problem",
    });
    const outcome = commandsForRequirementAction({ type: "reject" }, view);
    expect(outcome.commands).toHaveLength(0);
    expect(outcome.ask).toContain("开发点 1");
    expect(outcome.ask).toContain("已完成");
  });

  it("deploy / publish only fire when the stage allows it", async () => {
    const { view } = await harness();
    expect(commandsForRequirementAction({ type: "deploy" }, view).commands).toEqual([
      { type: "deploy.test", payload: { deliveryId: "dlv-1" } },
    ]);
    expect(commandsForRequirementAction({ type: "publish" }, view).commands).toEqual([
      { type: "deploy.promote", payload: { deliveryId: "dlv-1" } },
    ]);

    const released = (await harness({ delivery: "RELEASED" })).view;
    expect(commandsForRequirementAction({ type: "publish" }, released).ask).toContain("上线");
    expect(commandsForRequirementAction({ type: "reject" }, released).ask).toContain("新需求");
  });

  it("create keeps the user's own wording and shortens a title from it", async () => {
    const { view } = await harness();
    const outcome = commandsForRequirementAction(
      { type: "create", payload: { statement: "菜单栏的间距也要改一下\n顺便看看移动端" } },
      view,
    );
    expect(outcome.commands[0]).toEqual({
      type: "problem.create",
      payload: { title: "菜单栏的间距也要改一下", statement: "菜单栏的间距也要改一下\n顺便看看移动端" },
    });
  });
});

describe("intent normalisation (TASK-1244)", () => {
  it("accepts a user-level action and drops invented ids", () => {
    const result = normalizeIntent({
      kind: "act",
      action: "reject",
      payload: { feedback: "还是不对", taskId: "task-smuggled-0" },
      confidence: 0.8,
    });

    expect(result.action).toEqual({ type: "reject", payload: { feedback: "还是不对" } });
    expect(result.command).toBeUndefined();
  });

  it("keeps only the fields each action uses", () => {
    expect(normalizeIntent({ action: "deploy", payload: { deliveryId: "dlv-x" } }).action).toEqual({
      type: "deploy",
      payload: {},
    });
    expect(normalizeIntent({ action: "clarify", payload: { question: "要发布吗？" } }).action).toEqual(
      { type: "clarify", payload: { question: "要发布吗？" } },
    );
  });

  it("treats an unknown action as no intent", () => {
    expect(normalizeIntent({ action: "rollback" }).action).toBeUndefined();
  });
});
