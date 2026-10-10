import { describe, expect, it } from "vitest";
import type { MessageBlock } from "../src/channel/message.js";
import { renderReviewMessage, REVIEW_ACTIONS } from "../src/channel/rendering/review.js";
import { renderRunMessage } from "../src/channel/rendering/run.js";
import { renderTaskMessage } from "../src/channel/rendering/task.js";
import { renderDeliveryMessage } from "../src/channel/rendering/delivery.js";
import { buildDelivery, buildRelease } from "../src/domain/delivery.js";
import type { Run } from "../src/domain/run.js";
import type { Task } from "../src/domain/task.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-001",
    repositoryId: "repo-a",
    targets: [
      {
        id: "tgt-a",
        taskId: "task-001",
        repositoryId: "repo-a",
        role: "primary",
        position: 0,
        baseRef: "main",
        required: true,
        createdAt: "",
      },
    ],
    title: "Implement authentication",
    description: "d",
    status: "READY",
    priority: 50,
    acceptance: ["tests pass"],
    constraints: {},
    maxAttempts: 3,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-001",
    taskId: "task-001",
    status: "SUCCEEDED",
    attempt: 1,
    agent: "codex",
    engine: "codex",
    createdAt: "",
    ...overrides,
  };
}

function textOf(blocks: MessageBlock[] | undefined): string {
  return (blocks ?? [])
    .map((block) => {
      switch (block.type) {
        case "text":
        case "markdown":
        case "code":
          return block.text;
        case "section":
          return `${block.title ?? ""}\n${block.text}`;
        case "actions":
          return block.actions.map((action) => action.label).join(" ");
        default:
          return "";
      }
    })
    .join("\n");
}

describe("Business rendering (TASK-1105)", () => {
  it("renders a single-repository task", () => {
    const message = renderTaskMessage(task(), {
      repositoryNames: new Map([["repo-a", "rehelu"]]),
    });
    const rendered = textOf(message.blocks);

    expect(message.conversationId).toBe("task-001");
    expect(rendered).toContain("task-001 · Implement authentication");
    expect(rendered).toContain("状态：待执行");
    expect(rendered).toContain("#0 主仓库 · rehelu (repo-a) · 基线 main");
    expect(rendered).toContain("- tests pass");
  });

  it("renders a multi-repository task in target order", () => {
    const multi = task({
      targets: [
        { id: "tgt-a", taskId: "task-001", repositoryId: "repo-a", role: "primary", position: 0, required: true, createdAt: "" },
        { id: "tgt-b", taskId: "task-001", repositoryId: "repo-b", role: "supporting", position: 1, required: true, createdAt: "" },
      ],
    });
    const rendered = textOf(
      renderTaskMessage(multi, {
        repositoryNames: new Map([
          ["repo-a", "rehelu"],
          ["repo-b", "auth"],
        ]),
      }).blocks,
    );

    expect(rendered.indexOf("(repo-a)")).toBeLessThan(rendered.indexOf("(repo-b)"));
    expect(rendered).toContain("#1 辅助仓库 · auth (repo-b)");
  });

  it("renders dependency gating without querying a store (TASK-1204)", () => {
    const rendered = textOf(
      renderTaskMessage(task(), {
        dependency: {
          runnable: false,
          prerequisites: [
            { id: "task-a", title: "接口", status: "DONE" },
            { id: "task-b", status: "REVIEW" },
          ],
        },
      }).blocks,
    );

    expect(rendered).toContain("可运行：否");
    expect(rendered).toContain("依赖");
    expect(rendered).toContain("✓ task-a 接口（已完成）");
    expect(rendered).toContain("⏳ task-b（待评审）");
  });

  it("stays unchanged when no dependency view is passed", () => {
    const rendered = textOf(renderTaskMessage(task()).blocks);
    expect(rendered).not.toContain("可运行：");
    expect(rendered).not.toContain("依赖");
  });

  it("renders a successful run with per-target verification", () => {
    const succeeded = run({
      result: {
        workspaces: [
          { targetId: "tgt-a", path: "/ws/tgt-a", branch: "ai/task-001-run-001-t0" },
        ],
        targets: [
          {
            targetId: "tgt-a",
            repositoryId: "repo-a",
            repository: "rehelu",
            role: "primary",
            passed: true,
            workdir: "/workspace",
            checks: [{ command: "npm run build", status: "passed", exitCode: 0 }],
          },
        ],
      },
    });
    const rendered = textOf(renderRunMessage(succeeded).blocks);

    expect(rendered).toContain("run-001");
    expect(rendered).toContain("状态：执行完成");
    expect(rendered).toContain("ai/task-001-run-001-t0");
    expect(rendered).toContain("✓ rehelu (主仓库)");
    expect(rendered).toContain("验证：通过");
    expect(rendered).toContain("检查：npm run build → 通过 (exit 0)");
  });

  it("renders a failed run: failing target, check, exit code and truncated output", () => {
    const failed = run({
      status: "FAILED",
      result: {
        targets: [
          {
            targetId: "tgt-a",
            repositoryId: "repo-a",
            repository: "rehelu",
            role: "primary",
            passed: true,
            workdir: "/workspace",
            checks: [{ command: "npm run build", status: "passed", exitCode: 0 }],
          },
          {
            targetId: "tgt-b",
            repositoryId: "repo-b",
            repository: "auth",
            role: "supporting",
            passed: false,
            workdir: "/workspaces/tgt-b",
            checks: [
              {
                command: "npm test",
                status: "failed",
                exitCode: 1,
                output: "x".repeat(2_000),
              },
            ],
          },
        ],
      },
    });

    const blocks = renderRunMessage(failed, { maxOutputChars: 100 }).blocks ?? [];
    const rendered = textOf(blocks);

    expect(rendered).toContain("✗ auth (辅助仓库)");
    expect(rendered).toContain("验证：未通过");
    expect(rendered).toContain("检查：npm test → 未通过 (exit 1)");

    // Output is truncated, and target A's section never leaks target B's facts.
    const sections = blocks.filter(
      (block): block is Extract<MessageBlock, { type: "section" }> =>
        block.type === "section",
    );
    const authSection = sections.find((section) => section.title?.includes("auth"));
    const reheluSection = sections.find((section) => section.title?.includes("rehelu"));
    expect(authSection?.text).toContain("输出：");
    expect(authSection?.text.match(/x{100}…/)).toBeTruthy();
    expect(authSection?.text.includes("x".repeat(101))).toBe(false);
    expect(reheluSection?.text).not.toContain("npm test");
    expect(reheluSection?.text).not.toContain("/workspaces/tgt-b");
    expect(reheluSection?.text).not.toContain("x".repeat(50));
  });

  it("degrades safely when a run has no target evidence", () => {
    const rendered = textOf(renderRunMessage(run({ status: "FAILED" })).blocks);
    expect(rendered).toContain("状态：执行失败");
    expect(rendered).toContain("（没有记录目标仓库详情）");
  });

  it("surfaces a failed agent before the verification consequence (TASK-1218)", () => {
    const rendered = textOf(
      renderRunMessage(run({ status: "FAILED", exitCode: 1, result: undefined })).blocks,
    );
    expect(rendered).toContain("退出码 1");
    expect(rendered).toContain("agent 自身先失败");
  });

  it("says nothing about the agent when it exited cleanly", () => {
    expect(textOf(renderRunMessage(run({ exitCode: 0 })).blocks)).not.toContain("退出码");
    expect(textOf(renderRunMessage(run({})).blocks)).not.toContain("退出码");
  });

  it("renders a review card with counts and structured actions", () => {
    const reviewable = run({
      status: "SUCCEEDED",
      result: {
        targets: [
          {
            targetId: "tgt-a",
            repositoryId: "repo-a",
            repository: "rehelu",
            role: "primary",
            passed: true,
            checks: [{ command: "npm test", status: "passed", exitCode: 0 }],
          },
          {
            targetId: "tgt-b",
            repositoryId: "repo-b",
            repository: "auth",
            role: "supporting",
            passed: true,
            checks: [{ command: "cargo test", status: "passed", exitCode: 0 }],
          },
        ],
      },
    });
    const message = renderReviewMessage(reviewable);
    const rendered = textOf(message.blocks);

    expect(rendered).toContain("待评审");
    expect(rendered).toContain("✓ rehelu (主仓库)");
    expect(rendered).toContain("✓ auth (辅助仓库)");
    expect(rendered).toContain("- 通过 2 项");
    expect(rendered).toContain("- 未通过 0 项");

    const actions = (message.blocks ?? []).find(
      (block): block is Extract<MessageBlock, { type: "actions" }> =>
        block.type === "actions",
    );
    expect(actions?.actions.map((action) => action.id)).toEqual([
      REVIEW_ACTIONS.approve,
      REVIEW_ACTIONS.requestChanges,
    ]);
    expect(actions?.actions[0]).toMatchObject({ label: "通过", style: "primary" });
    // TASK-1216: the button must carry a taskId — review.approve rejects a run id.
    expect(JSON.parse(actions?.actions[0]?.value ?? "{}")).toEqual({
      taskId: reviewable.taskId,
    });
    expect(JSON.parse(actions?.actions[1]?.value ?? "{}")).toEqual({
      taskId: reviewable.taskId,
    });
  });

  it("renders failed review targets and failed-check counts", () => {
    const reviewable = run({
      status: "FAILED",
      result: {
        targets: [
          {
            targetId: "tgt-b",
            repositoryId: "repo-b",
            repository: "auth",
            role: "supporting",
            passed: false,
            checks: [{ command: "npm test", status: "failed", exitCode: 1 }],
          },
        ],
      },
    });
    const rendered = textOf(renderReviewMessage(reviewable).blocks);
    expect(rendered).toContain("✗ auth (辅助仓库)");
    expect(rendered).toContain("- 通过 0 项");
    expect(rendered).toContain("- 未通过 1 项");
  });

  it("renders a delivery aggregation with blocking and release state (TASK-1205)", () => {
    const delivery = buildDelivery({
      id: "dlv-001",
      specificationId: "spec-001",
      status: "BLOCKED",
    });
    const rendered = textOf(
      renderDeliveryMessage({
        delivery,
        tasks: [
          task({ id: "task-a", title: "接口", status: "DONE" }),
          task({ id: "task-b", title: "页面", status: "BLOCKED" }),
          task({
            id: "task-c",
            title: "文档",
            status: "REVIEW",
            targets: [
              {
                id: "tgt-c",
                taskId: "task-c",
                repositoryId: "repo-a",
                role: "primary",
                position: 0,
                required: false,
                createdAt: "",
              },
            ],
          }),
        ],
        blocking: [task({ id: "task-b", title: "页面", status: "BLOCKED" })],
      }).blocks,
    );

    expect(rendered).toContain("dlv-001 · 交付");
    expect(rendered).toContain("规格：spec-001");
    expect(rendered).toContain("状态：已阻塞");
    expect(rendered).toContain("✓ task-a 接口 · 已完成 · 必需");
    expect(rendered).toContain("✗ task-b 页面 · 已阻塞 · 必需");
    expect(rendered).toContain("○ task-c 文档 · 待评审 · 可选");
    expect(rendered).toContain("task-b 处于已阻塞");
    expect(rendered).toContain("（尚未发布）");
  });

  it("renders a released delivery with its release record", () => {
    const rendered = textOf(
      renderDeliveryMessage({
        delivery: buildDelivery({
          id: "dlv-002",
          specificationId: "spec-002",
          status: "RELEASED",
        }),
        tasks: [task({ id: "task-a", title: "接口", status: "DONE" })],
        release: buildRelease({
          id: "rel-001",
          deliveryId: "dlv-002",
          status: "RELEASED",
          createdBy: "cli:reviewer-1",
        }),
      }).blocks,
    );

    expect(rendered).toContain("状态：已上线");
    expect(rendered).toContain("rel-001 · 已发布");
    expect(rendered).toContain("由 cli:reviewer-1");
  });

  it("renders task dependency-blocked facts with chain and latest failure (TASK-1207)", () => {
    const rendered = textOf(
      renderTaskMessage(task({ id: "task-b", title: "B 页面", status: "READY" }), {
        dependency: {
          runnable: false,
          waiting: false,
          dependencyBlocked: true,
          prerequisites: [{ id: "task-x", title: "X 迁移", status: "BLOCKED" }],
          blockingTaskIds: ["task-x"],
          blockingChain: [
            { taskId: "task-x", title: "X 迁移", status: "BLOCKED" },
            { taskId: "task-b", title: "B 页面", status: "READY" },
          ],
        },
        latestFailure: {
          kind: "verification",
          command: "npm test",
          exitCode: 1,
          output: "3 tests failed",
        },
      }).blocks,
    );

    expect(rendered).toContain("状态：待执行");
    expect(rendered).toContain("可运行：否");
    expect(rendered).toContain("依赖阻塞：是");
    expect(rendered).toContain("被谁阻塞");
    expect(rendered).toContain("task-x —— 已阻塞");
    expect(rendered).toContain("阻塞链");
    expect(rendered).toContain("task-x X 迁移");
    expect(rendered).toContain("task-b B 页面");
    expect(rendered).toContain("最近一次失败");
    expect(rendered).toContain("验证未通过：npm test · 退出码 1");
    expect(rendered).toContain("3 tests failed");
  });

  it("renders delivery blocking chain and failure evidence (TASK-1207)", () => {
    const rendered = textOf(
      renderDeliveryMessage({
        delivery: buildDelivery({
          id: "dlv-003",
          specificationId: "spec-003",
          status: "BLOCKED",
        }),
        tasks: [
          task({ id: "task-a", title: "A 接口", status: "DONE" }),
          task({ id: "task-b", title: "B 页面", status: "READY" }),
        ],
        blockingFacts: [
          {
            taskId: "task-b",
            taskTitle: "B 页面",
            state: "dependency-blocked",
            blockingTaskIds: ["task-x"],
            chain: [
              { taskId: "task-x", title: "X 迁移", status: "BLOCKED" },
              { taskId: "task-b", title: "B 页面", status: "READY", note: "blocked by task-x" },
            ],
            evidence: {
              kind: "verification",
              command: "npm test",
              exitCode: 1,
              output: "3 tests failed",
            },
          },
        ],
      }).blocks,
    );

    expect(rendered).toContain("状态：已阻塞");
    expect(rendered).toContain("✓ task-a A 接口 · 已完成 · 必需");
    expect(rendered).toContain("✗ task-b B 页面 · 被依赖阻塞（等待 task-x）");
    expect(rendered).toContain("阻塞链");
    expect(rendered).toContain("task-x X 迁移（已阻塞）");
    expect(rendered).toContain("等待 task-x");
    expect(rendered).toContain("失败原因");
    expect(rendered).toContain("task-x: 验证未通过：npm test · 退出码 1");
    expect(rendered).toContain("3 tests failed");
  });
});

describe("Run card next step (TASK-1264)", () => {
  it("says what happens next and what the user must do", () => {
    const rendered = textOf(
      renderRunMessage(run(), {
        nextStep: {
          automatic: "按评审意见自动重跑一轮（第 2 轮）",
          yours: "不用你操作，这一轮结果我会发在这里。",
        },
      }).blocks,
    );

    expect(rendered).toContain("接下来");
    expect(rendered).toContain("会自动：按评审意见自动重跑一轮（第 2 轮）");
    expect(rendered).toContain("需要你：不用你操作");
  });

  it("offers the buttons when a human decision is needed", () => {
    const message = renderRunMessage(run(), {
      nextStep: {
        yours: "选一个下一步：「推测试环境」",
        actions: [{ id: "requirement.next", label: "推测试环境", style: "primary" }],
      },
    });
    const actions = (message.blocks ?? []).find(
      (block): block is Extract<MessageBlock, { type: "actions" }> =>
        block.type === "actions",
    );

    expect(actions?.actions.map((action) => action.label)).toEqual(["推测试环境"]);
  });

  it("never leaves a run card without a next step", () => {
    const rejected = renderRunMessage(
      run({
        result: {
          review: { verdict: "request_changes", criteria: [], risks: [], notes: "n" },
        },
      }),
    );
    expect(textOf(rejected.blocks)).toContain("接下来");
    expect(textOf(rejected.blocks)).toContain("按评审意见自动重跑一轮（第 2 轮）");

    // No review at all: still says the user is not needed.
    const plain = textOf(renderRunMessage(run()).blocks);
    expect(plain).toContain("接下来");
    expect(plain).toContain("需要你：不用你操作");
  });
});
