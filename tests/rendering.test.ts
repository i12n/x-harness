import { describe, expect, it } from "vitest";
import type { MessageBlock } from "../src/channel/message.js";
import { renderReviewMessage, REVIEW_ACTIONS } from "../src/channel/rendering/review.js";
import { renderRunMessage } from "../src/channel/rendering/run.js";
import { renderTaskMessage } from "../src/channel/rendering/task.js";
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
    expect(rendered).toContain("Status: READY");
    expect(rendered).toContain("#0 primary · rehelu (repo-a) · base main");
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
    expect(rendered).toContain("#1 supporting · auth (repo-b)");
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
    expect(rendered).toContain("Status: SUCCEEDED");
    expect(rendered).toContain("ai/task-001-run-001-t0");
    expect(rendered).toContain("✓ rehelu (primary)");
    expect(rendered).toContain("Verification: PASS");
    expect(rendered).toContain("check: npm run build → passed (exit 0)");
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

    expect(rendered).toContain("✗ auth (supporting)");
    expect(rendered).toContain("Verification: FAIL");
    expect(rendered).toContain("check: npm test → failed (exit 1)");

    // Output is truncated, and target A's section never leaks target B's facts.
    const sections = blocks.filter(
      (block): block is Extract<MessageBlock, { type: "section" }> =>
        block.type === "section",
    );
    const authSection = sections.find((section) => section.title?.includes("auth"));
    const reheluSection = sections.find((section) => section.title?.includes("rehelu"));
    expect(authSection?.text).toContain("output: ");
    expect(authSection?.text.match(/x{100}…/)).toBeTruthy();
    expect(authSection?.text.includes("x".repeat(101))).toBe(false);
    expect(reheluSection?.text).not.toContain("npm test");
    expect(reheluSection?.text).not.toContain("/workspaces/tgt-b");
    expect(reheluSection?.text).not.toContain("x".repeat(50));
  });

  it("degrades safely when a run has no target evidence", () => {
    const rendered = textOf(renderRunMessage(run({ status: "FAILED" })).blocks);
    expect(rendered).toContain("Status: FAILED");
    expect(rendered).toContain("(no target details recorded)");
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

    expect(rendered).toContain("Ready for Review");
    expect(rendered).toContain("✓ rehelu (primary)");
    expect(rendered).toContain("✓ auth (supporting)");
    expect(rendered).toContain("- 2 passed");
    expect(rendered).toContain("- 0 failed");

    const actions = (message.blocks ?? []).find(
      (block): block is Extract<MessageBlock, { type: "actions" }> =>
        block.type === "actions",
    );
    expect(actions?.actions.map((action) => action.id)).toEqual([
      REVIEW_ACTIONS.approve,
      REVIEW_ACTIONS.requestChanges,
    ]);
    expect(actions?.actions[0]).toMatchObject({ label: "Approve", style: "primary" });
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
    expect(rendered).toContain("✗ auth (supporting)");
    expect(rendered).toContain("- 0 passed");
    expect(rendered).toContain("- 1 failed");
  });
});
