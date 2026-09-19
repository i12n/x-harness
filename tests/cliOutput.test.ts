import { describe, expect, it } from "vitest";
import { formatRunDetails, formatTaskTargets } from "../src/cli/output.js";
import { formatSpecificationPlan } from "../src/cli/specificationOutput.js";
import { buildSpecification } from "../src/domain/specification.js";
import type { Run } from "../src/domain/run.js";
import type { Task } from "../src/domain/task.js";

const task: Task = {
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
    {
      id: "tgt-b",
      taskId: "task-001",
      repositoryId: "repo-b",
      role: "supporting",
      position: 1,
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
};

const run: Run = {
  id: "run-001",
  taskId: "task-001",
  status: "FAILED",
  attempt: 1,
  agent: "codex",
  engine: "codex",
  createdAt: "",
  result: {
    workspaces: [
      { targetId: "tgt-a", path: "/ws/tgt-a", branch: "ai/task-001-run-001-t0" },
      { targetId: "tgt-b", path: "/ws/tgt-b", branch: "ai/task-001-run-001-t1" },
    ],
    targets: [
      {
        targetId: "tgt-a",
        repositoryId: "repo-a",
        repository: "frontend",
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
            output: "3 tests failed",
          },
        ],
      },
    ],
  },
  error: {
    failingTargets: [
      {
        targetId: "tgt-b",
        repositoryId: "repo-b",
        checks: [
          {
            command: "npm test",
            status: "failed",
            exitCode: 1,
            output: "3 tests failed",
          },
        ],
      },
    ],
  },
};

describe("CLI output (TASK-1011)", () => {
  it("shows every task target with role, position and base ref", () => {
    const lines = formatTaskTargets(
      task,
      new Map([
        ["repo-a", "frontend"],
        ["repo-b", "auth"],
      ]),
    ).join("\n");

    expect(lines).toContain("Targets:");
    expect(lines).toContain("#0  primary");
    expect(lines).toContain("repository: frontend (repo-a)");
    expect(lines).toContain("base_ref: main");
    expect(lines).toContain("#1  supporting");
    expect(lines).toContain("repository: auth (repo-b)");
    expect(lines).toContain("base_ref: (repository default)");
  });

  it("shows workspaces and per-target verification on a run", () => {
    const lines = formatRunDetails(run).join("\n");

    expect(lines).toContain("Run: run-001");
    expect(lines).toContain("Status: FAILED");
    expect(lines).toContain("- tgt-a  /ws/tgt-a");
    expect(lines).toContain("- tgt-b  /ws/tgt-b");
    expect(lines).toContain("tgt-a [primary] frontend PASS");
    expect(lines).toContain("tgt-b [supporting] auth FAIL");
    expect(lines).toContain("workdir: /workspaces/tgt-b");
    expect(lines).toContain("check: npm test failed (exit 1)");
    expect(lines).toContain("output: 3 tests failed");
  });

  it("falls back to the failure summary when only error.failingTargets exists", () => {
    const minimal: Run = {
      ...run,
      result: undefined,
    };

    const lines = formatRunDetails(minimal).join("\n");

    expect(lines).toContain("tgt-b [supporting] repo-b FAIL");
    expect(lines).toContain("check: npm test failed (exit 1)");
    expect(lines).toContain("output: 3 tests failed");
  });
});

describe("formatSpecificationPlan (TASK-1202)", () => {
  const specification = {
    ...buildSpecification({
      id: "spec-001",
      problemId: "prob-001",
      title: "专辑页面",
      summary: "浏览专辑曲目",
      acceptance: ["可以打开专辑页"],
      status: "PLANNED",
      requirements: ["列表页显示曲目", "详情页显示歌词"],
      targets: [
        { repositoryId: "repo-a", role: "primary", position: 0, baseRef: "main" },
        { repositoryId: "repo-b", role: "supporting", position: 1 },
      ],
    }),
  };

  it("prints status, targets and the plan item → task mapping", () => {
    const lines = formatSpecificationPlan({
      specification,
      planItems: [
        {
          id: "plan-spec-001-0",
          specificationId: "spec-001",
          position: 0,
          title: "列表页显示曲目",
          description: "",
          taskId: "task-spec-001-0",
          createdAt: "",
          updatedAt: "",
        },
      ],
      tasks: [{ ...task, id: "task-spec-001-0", status: "INBOX" }],
      replayed: false,
    }).join("\n");

    expect(lines).toContain("spec-001 · 专辑页面");
    expect(lines).toContain("Status: PLANNED");
    expect(lines).toContain("#0  primary    repository: repo-a  base_ref: main");
    expect(lines).toContain("#1  supporting repository: repo-b");
    expect(lines).toContain("#0  列表页显示曲目");
    expect(lines).toContain("task: task-spec-001-0  status: INBOX");
    expect(lines).toContain("Replayed: no");
  });

  it("prints an unplanned specification safely", () => {
    const lines = formatSpecificationPlan({
      specification: { ...specification, status: "READY", targets: [] },
      planItems: [],
      tasks: [],
    }).join("\n");

    expect(lines).toContain("Status: READY");
    expect(lines).toContain("(not planned)");
    expect(lines).not.toContain("Replayed");
  });
});
