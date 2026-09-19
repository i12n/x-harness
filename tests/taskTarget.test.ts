import { describe, expect, it } from "vitest";
import { buildTaskTarget } from "../src/domain/taskTarget.js";
import { ValidationError } from "../src/errors.js";

describe("TaskTarget (TASK-1003)", () => {
  it("defaults to primary, position 0, required true", () => {
    const target = buildTaskTarget({ taskId: "task-001", repositoryId: "repo-001" });
    expect(target.role).toBe("primary");
    expect(target.position).toBe(0);
    expect(target.required).toBe(true);
    expect(target.baseRef).toBeUndefined();
    expect(target.id).toMatch(/^tgt-/);
  });

  it("keeps an explicit baseRef and role", () => {
    const target = buildTaskTarget({
      id: "tgt-1",
      taskId: "task-001",
      repositoryId: "repo-002",
      role: "supporting",
      position: 1,
      baseRef: "release/2.1",
    });
    expect(target).toMatchObject({
      id: "tgt-1",
      role: "supporting",
      position: 1,
      baseRef: "release/2.1",
    });
  });

  it("requires task and repository ids", () => {
    expect(() =>
      buildTaskTarget({ taskId: "", repositoryId: "repo-001" }),
    ).toThrow(ValidationError);
    expect(() =>
      buildTaskTarget({ taskId: "task-001", repositoryId: " " }),
    ).toThrow(ValidationError);
    expect(() =>
      // @ts-expect-error invalid role on purpose
      buildTaskTarget({ taskId: "t", repositoryId: "r", role: "dependency" }),
    ).toThrow(ValidationError);
  });
});
