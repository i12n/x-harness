import { describe, expect, it } from "vitest";
import { buildDeliveryAcceptance } from "../src/delivery/application/acceptance.js";
import { renderDeliveryMessage } from "../src/channel/rendering/delivery.js";
import type { MessageBlock } from "../src/channel/message.js";
import { buildDelivery } from "../src/domain/delivery.js";
import type { Task } from "../src/domain/task.js";
import type { Run } from "../src/domain/run.js";
import { buildAcceptanceEvidence } from "../src/verification/acceptance.js";

function task(id: string, status: Task["status"]): Task {
  return {
    id,
    repositoryId: "repo-x",
    targets: [],
    title: `${id} title`,
    description: "d",
    status,
    priority: 50,
    acceptance: ["a"],
    constraints: {},
    maxAttempts: 3,
    createdAt: "",
    updatedAt: "",
  };
}

function run(result: unknown): Run {
  return {
    id: "run-1",
    taskId: "task-1",
    status: "SUCCEEDED",
    attempt: 1,
    agent: "codex",
    engine: "codex",
    createdAt: "",
    result,
  };
}

const textOf = (blocks: MessageBlock[] | undefined): string =>
  (blocks ?? []).map((block) => JSON.stringify(block)).join("\n");

describe("delivery acceptance (TASK-1223)", () => {
  it("is ready when every task is done and nothing needs a human", async () => {
    const view = await buildDeliveryAcceptance({
      delivery: buildDelivery({ id: "dlv-1", specificationId: "spec-1", status: "READY_FOR_RELEASE" }),
      tasks: [task("task-1", "DONE")],
      runs: {
        listRuns: async () => [
          run({
            acceptance: buildAcceptanceEvidence(["a"], ["npm test"]),
            review: { verdict: "approve", criteria: [], risks: [], notes: "ok" },
          }),
        ],
      },
    });

    expect(view.ready).toBe(true);
    expect(view.requiresHumanAcceptance).toBe(false);
    expect(view.tasks[0]!.review?.verdict).toBe("approve");
  });

  it("keeps a human when a criterion had no executable proof", async () => {
    const view = await buildDeliveryAcceptance({
      delivery: buildDelivery({ id: "dlv-1", specificationId: "spec-1", status: "READY_FOR_RELEASE" }),
      tasks: [task("task-1", "DONE")],
      runs: {
        listRuns: async () => [run({ acceptance: buildAcceptanceEvidence(["a"], []) })],
      },
    });

    expect(view.requiresHumanAcceptance).toBe(true);
    expect(view.reasons.join()).toContain("没有可执行检查");
  });

  it("lists unfinished tasks as reasons instead of offering release", async () => {
    const view = await buildDeliveryAcceptance({
      delivery: buildDelivery({ id: "dlv-1", specificationId: "spec-1", status: "IN_PROGRESS" }),
      tasks: [task("task-1", "REVIEW")],
    });

    expect(view.ready).toBe(false);
    expect(view.requiresHumanAcceptance).toBe(true);
    expect(view.reasons.join()).toContain("还没完成");
  });
});

describe("delivery card (TASK-1223)", () => {
  const delivery = buildDelivery({
    id: "dlv-1",
    specificationId: "spec-1",
    status: "READY_FOR_RELEASE",
  });

  it("offers exactly one confirmation when the delivery is ready", () => {
    const text = textOf(
      renderDeliveryMessage(
        {
          delivery,
          tasks: [task("task-1", "DONE")],
          acceptance: {
            deliveryId: "dlv-1",
            status: "READY_FOR_RELEASE",
            tasks: [
              {
                taskId: "task-1",
                title: "t",
                status: "DONE",
                review: { verdict: "approve", notes: "" },
              },
            ],
            ready: true,
            requiresHumanAcceptance: false,
            reasons: [],
          },
        },
      ).blocks,
    );

    expect(text).toContain("验收");
    expect(text).toContain("delivery.release");
    expect(text).toContain("确认验收并发布");
  });

  it("explains what a human still has to judge and offers no button", () => {
    const text = textOf(
      renderDeliveryMessage(
        {
          delivery,
          tasks: [task("task-1", "DONE")],
          acceptance: {
            deliveryId: "dlv-1",
            status: "READY_FOR_RELEASE",
            tasks: [{ taskId: "task-1", title: "t", status: "DONE" }],
            ready: false,
            requiresHumanAcceptance: true,
            reasons: ["task-1 有验收标准没有可执行检查"],
          },
        },
      ).blocks,
    );

    expect(text).toContain("需要人验收");
    expect(text).not.toContain("确认验收并发布");
  });
});
