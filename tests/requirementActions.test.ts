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
    /** Deliverable titles, in plan order. */
    titles?: string[];
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
    const title = options.titles?.[index] ?? `开发点 ${index + 1}`;
    await tasks.createTask({
      id: entry.id,
      repositoryId: "repo-1",
      title,
      status: entry.status as never,
    });
    await plans.createPlanItem({
      specificationId: "spec-1",
      position: index,
      title,
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
    // No tasks (yet) means the conversation is bound to the requirement itself.
    subjectType: options.bound === "problem" || taskSpecs.length === 0 ? "problem" : "task",
    subjectId:
      options.bound === "problem" || taskSpecs.length === 0 ? "prob-1" : taskSpecs[0]!.id,
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

  // TASK-1267: at an acceptance stage the opinion is about the *delivery*. It
  // becomes one more round of work on top of what the user is looking at — no
  // task is reopened, and the user is never asked which one to reopen.
  it("an acceptance-stage opinion becomes one revision of the delivery", async () => {
    const { view } = await harness();
    const outcome = commandsForRequirementAction(
      { type: "reject", payload: { feedback: "间距应该是 24px" } },
      view,
    );

    expect(outcome.commands).toEqual([
      {
        type: "delivery.revise",
        payload: { deliveryId: "dlv-1", statement: "间距应该是 24px" },
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

  // TASK-1267: how the delivery was split into deliverables is the harness's
  // implementation detail. Two deliverables or ten, the answer is the same: one
  // revision of the delivery.
  it("does not care how the delivery was split into deliverables", async () => {
    const { view } = await harness({
      tasks: [
        { id: "task-spec-1-0", status: "DONE" },
        { id: "task-spec-1-1", status: "DONE" },
      ],
      bound: "problem",
    });
    const outcome = commandsForRequirementAction(
      { type: "reject", payload: { feedback: "按钮风格要统一" } },
      view,
    );
    expect(outcome.commands).toEqual([
      {
        type: "delivery.revise",
        payload: { deliveryId: "dlv-1", statement: "按钮风格要统一" },
      },
    ]);
  });

  // The exact input that started this: a description of the change, with no
  // mention of tasks, deliverables or scope — and no question back.
  it("turns the real acceptance message into one revision", async () => {
    const feedback =
      "做如下调整：歌曲详情页的下载按钮，夹在播放和喜欢两个按钮之间，样式与其他两个按钮不统一。需要对这三个按钮做统一的设计，风格统一且美观。";
    const { view } = await harness({
      titles: [
        "在歌曲列表添加单曲下载按钮并实现统一单曲",
        "在歌曲详情页添加下载按钮并确认播放器无下",
      ],
      tasks: [
        { id: "task-spec-1-0", status: "DONE" },
        { id: "task-spec-1-1", status: "DONE" },
      ],
      bound: "problem",
    });

    const outcome = commandsForRequirementAction(
      { type: "reject", payload: { feedback } },
      view,
    );

    expect(outcome.ask).toBeUndefined();
    expect(outcome.commands).toEqual([
      {
        type: "delivery.revise",
        payload: { deliveryId: "dlv-1", statement: feedback },
      },
    ]);
  });

  // A "打回" with no words is a content question, not a task question.
  it("asks what to change when the 打回 carries no words", async () => {
    const { view } = await harness({
      tasks: [
        { id: "task-spec-1-0", status: "DONE" },
        { id: "task-spec-1-1", status: "DONE" },
      ],
      bound: "problem",
    });

    const outcome = commandsForRequirementAction({ type: "reject" }, view);

    expect(outcome.commands).toHaveLength(0);
    expect(outcome.ask).toContain("要改哪儿");
    expect(outcome.ask).not.toContain("开发点");
  });

  // The task-level path survives only where there is no delivery to revise yet:
  // a deliverable stuck or waiting for a verdict while the requirement is still
  // being built. Even there the user is never asked which one.
  it("picks the stuck deliverable the complaint names, without asking", async () => {
    const { view } = await harness({
      titles: ["列表页的下载按钮", "详情页的下载按钮"],
      tasks: [
        { id: "task-spec-1-0", status: "BLOCKED" },
        { id: "task-spec-1-1", status: "BLOCKED" },
      ],
      delivery: "IN_PROGRESS",
      bound: "problem",
    });

    const outcome = commandsForRequirementAction(
      { type: "reject", payload: { feedback: "详情页的下载按钮不对" } },
      view,
    );

    expect(outcome.ask).toBeUndefined();
    expect(outcome.commands).toEqual([
      {
        type: "review.request_changes",
        payload: { taskId: "task-spec-1-1", feedback: "详情页的下载按钮不对" },
      },
    ]);
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
    // TASK-1256: 已上线之后「测试部署」没有可测的内容——直接说清楚，
    // 不要让它去重建测试分支再抛一个 git 错误。
    const releasedDeploy = commandsForRequirementAction({ type: "deploy" }, released);
    expect(releasedDeploy.commands).toEqual([]);
    expect(releasedDeploy.ask).toContain("已经上线");
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

  // TASK-1250: a brand-new chat (or an empty database) must still be able to
  // open a requirement — `create` never needs an existing one.
  it("creates without any requirement to resolve", async () => {
    const outcome = commandsForRequirementAction(
      { type: "create", payload: { statement: "面包屑间距改成 8px" } },
      undefined,
    );

    expect(outcome.commands).toEqual([
      {
        type: "problem.create",
        payload: { title: "面包屑间距改成 8px", statement: "面包屑间距改成 8px" },
      },
    ]);
  });

  it("asks instead of pretending when nothing is bound", async () => {
    const outcome = commandsForRequirementAction(
      { type: "reject", payload: { feedback: "还是不对" } },
      undefined,
    );
    expect(outcome.commands).toHaveLength(0);
    expect(outcome.ask).toContain("还没有对应的需求");
  });

  // TASK-1252: "开始做吧 / 重试生成规格" on a requirement whose derivation failed
  // must advance it (derive + plan), not report "nothing to re-run".
  it("advances a confirmed requirement that has no specification yet", async () => {
    const { resolver, view } = await harness({ tasks: [] });
    // A confirmed problem with no specification and no tasks.
    const bare = { ...view, specification: undefined, tasks: [], currentTask: undefined };
    expect(await resolver.resolve("conv-1")).toBeDefined();

    const outcome = commandsForRequirementAction({ type: "rerun" }, bare);

    expect(outcome.commands).toHaveLength(0);
    expect(outcome.advance).toBe(true);
  });

  // TASK-1254: "通过 / 可以了" — the stage decides what is being accepted.
  it("通过 accepts a task waiting for review", async () => {
    const { view } = await harness({
      tasks: [{ id: "task-spec-1-0", status: "REVIEW" }],
      delivery: "IN_PROGRESS",
    });
    const outcome = commandsForRequirementAction({ type: "approve" }, view);
    expect(outcome.commands).toEqual([
      { type: "review.approve", payload: { taskId: "task-spec-1-0" } },
    ]);
  });

  it("通过 publishes an accepted delivery", async () => {
    const { view } = await harness();
    const outcome = commandsForRequirementAction({ type: "approve" }, view);
    expect(outcome.commands).toEqual([
      { type: "deploy.promote", payload: { deliveryId: "dlv-1" } },
    ]);
  });

  it("通过 says what is actually waiting when nothing is", async () => {
    const { view } = await harness({
      tasks: [{ id: "task-spec-1-0", status: "RUNNING" }],
      delivery: "IN_PROGRESS",
    });
    const outcome = commandsForRequirementAction({ type: "approve" }, view);
    expect(outcome.commands).toHaveLength(0);
    expect(outcome.ask).toContain("还在开发中");
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

  // TASK-1267: answering 「这次改哪一个？」 must survive normalisation — it used to
  // be dropped, so the model's answer could never reach the harness.
  it("keeps the redo scope the model read off the question", () => {
    expect(
      normalizeIntent({
        action: "reject",
        payload: { scope: "item", item: "②", feedback: "详情页按钮要统一" },
      }).action,
    ).toEqual({
      type: "reject",
      payload: { feedback: "详情页按钮要统一", scope: "item", item: "②" },
    });
    expect(normalizeIntent({ action: "reject", payload: { scope: "全部" } }).action).toEqual({
      type: "reject",
      payload: {},
    });
  });

  it("treats an unknown action as no intent", () => {
    expect(normalizeIntent({ action: "rollback" }).action).toBeUndefined();
  });
});
