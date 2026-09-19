import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_FAILURE_STATUSES,
  getTaskDependencyImpact,
} from "../src/domain/taskDependency.js";
import type { TaskDependencySnapshot } from "../src/domain/taskDependency.js";
import type { TaskStatus } from "../src/domain/task.js";

function snapshot(
  statuses: Record<string, TaskStatus>,
  dependencies: [string, string][] = [],
): TaskDependencySnapshot {
  return {
    tasks: Object.entries(statuses).map(([id, status]) => ({ id, status })),
    dependencies: dependencies.map(([taskId, dependsOnTaskId]) => ({
      taskId,
      dependsOnTaskId,
    })),
  };
}

describe("Task dependency impact (TASK-1207)", () => {
  it("treats FAILED as a blocking ancestor", () => {
    const impact = getTaskDependencyImpact(
      "task-b",
      snapshot({ "task-a": "FAILED", "task-b": "READY" }, [["task-b", "task-a"]]),
    );

    expect(impact).toEqual({
      runnable: false,
      waiting: false,
      dependencyBlocked: true,
      blockingTaskIds: ["task-a"],
      blockingChain: ["task-a", "task-b"],
      missingTaskIds: [],
    });
  });

  it("treats BLOCKED as a blocking ancestor", () => {
    const impact = getTaskDependencyImpact(
      "task-b",
      snapshot({ "task-a": "BLOCKED", "task-b": "READY" }, [["task-b", "task-a"]]),
    );

    expect(impact.dependencyBlocked).toBe(true);
    expect(impact.blockingTaskIds).toEqual(["task-a"]);
    expect(DEPENDENCY_FAILURE_STATUSES).toEqual(["FAILED", "BLOCKED"]);
  });

  it("propagates blocking transitively with a deterministic chain", () => {
    const graph = snapshot(
      {
        "task-a": "FAILED",
        "task-b": "READY",
        "task-c": "READY",
      },
      [
        ["task-b", "task-a"],
        ["task-c", "task-b"],
      ],
    );

    const c = getTaskDependencyImpact("task-c", graph);
    expect(c.dependencyBlocked).toBe(true);
    expect(c.blockingTaskIds).toEqual(["task-a"]);
    expect(c.blockingChain).toEqual(["task-a", "task-b", "task-c"]);
    // B is itself blocked, C only sees the failing ancestor.
    expect(getTaskDependencyImpact("task-b", graph).blockingChain).toEqual([
      "task-a",
      "task-b",
    ]);
  });

  it("leaves unrelated branches runnable and reports waiting separately", () => {
    const graph = snapshot(
      {
        "task-a": "FAILED",
        "task-b": "READY",
        "task-c": "READY",
        "task-d": "READY",
        "task-e": "RUNNING",
      },
      [
        ["task-b", "task-a"],
        ["task-c", "task-e"],
        ["task-d", "task-a"],
      ],
    );

    // c waits for a task that is merely running: waiting, not blocked.
    expect(getTaskDependencyImpact("task-c", graph)).toMatchObject({
      runnable: false,
      waiting: true,
      dependencyBlocked: false,
      blockingTaskIds: [],
      blockingChain: [],
    });
    // d is blocked by the same failed ancestor as b.
    expect(getTaskDependencyImpact("task-d", graph).dependencyBlocked).toBe(true);
    // e has no prerequisites → the failure elsewhere does not matter.
    expect(getTaskDependencyImpact("task-e", graph)).toMatchObject({
      runnable: false,
      waiting: false,
      dependencyBlocked: false,
    });
  });

  it("keeps the TASK-1203 runnable rule (all prerequisites DONE)", () => {
    const graph = snapshot(
      { "task-a": "DONE", "task-b": "DONE", "task-c": "READY" },
      [
        ["task-c", "task-a"],
        ["task-c", "task-b"],
      ],
    );

    expect(getTaskDependencyImpact("task-c", graph)).toEqual({
      runnable: true,
      waiting: false,
      dependencyBlocked: false,
      blockingTaskIds: [],
      blockingChain: [],
      missingTaskIds: [],
    });
  });

  it("treats dependency-free tasks exactly as before", () => {
    expect(getTaskDependencyImpact("task-a", snapshot({ "task-a": "READY" }))).toEqual({
      runnable: true,
      waiting: false,
      dependencyBlocked: false,
      blockingTaskIds: [],
      blockingChain: [],
      missingTaskIds: [],
    });
    expect(getTaskDependencyImpact("task-a", snapshot({ "task-a": "INBOX" }))).toMatchObject({
      runnable: false,
      waiting: false,
      dependencyBlocked: false,
    });
  });

  it("does not mark an already started task as dependency-blocked", () => {
    const graph = snapshot(
      { "task-a": "FAILED", "task-b": "RUNNING" },
      [["task-b", "task-a"]],
    );

    expect(getTaskDependencyImpact("task-b", graph)).toMatchObject({
      runnable: false,
      waiting: false,
      dependencyBlocked: false,
      blockingTaskIds: [],
      blockingChain: [],
    });
  });

  it("reports dangling edges as blocked with missingTaskIds", () => {
    const impact = getTaskDependencyImpact(
      "task-b",
      snapshot({ "task-b": "READY" }, [["task-b", "task-missing"]]),
    );

    expect(impact).toMatchObject({
      runnable: false,
      dependencyBlocked: true,
      blockingTaskIds: [],
      missingTaskIds: ["task-missing"],
    });
  });

  it("returns an unknown task without throwing", () => {
    const impact = getTaskDependencyImpact("task-missing", snapshot({}));
    expect(impact).toMatchObject({
      runnable: false,
      dependencyBlocked: false,
      missingTaskIds: ["task-missing"],
    });
  });
});
