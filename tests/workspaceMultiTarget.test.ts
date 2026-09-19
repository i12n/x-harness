import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../src/workspace/manager.js";
import {
  createGitFixture,
  runGit,
  type GitFixture,
} from "./helpers/gitFixture.js";

describe("WorkspaceManager multi-target (TASK-1005)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function setup() {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    const baseDir = mkdtempSync(join(tmpdir(), "ai-multi-ws-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    return { fixture, manager: new WorkspaceManager({ baseDir }), baseDir };
  }

  it("creates one workspace per target, ordered by position", async () => {
    const { fixture, manager } = setup();

    const workspaces = await manager.createRunWorkspaces({
      taskId: "task-001",
      runId: "run-001",
      targets: [
        { targetId: "tgt-b", repositoryLocalPath: fixture.path, position: 1 },
        { targetId: "tgt-a", repositoryLocalPath: fixture.path, position: 0 },
      ],
    });

    expect(workspaces.map((workspace) => workspace.targetId)).toEqual([
      "tgt-a",
      "tgt-b",
    ]);
    expect(workspaces[0]?.path.endsWith("/task-001/run-001/tgt-a")).toBe(true);
    expect(workspaces[1]?.path.endsWith("/task-001/run-001/tgt-b")).toBe(true);
    expect(workspaces[0]?.branch).toBe("ai/task-001-run-001-t0");
    expect(workspaces[1]?.branch).toBe("ai/task-001-run-001-t1");
    expect(existsSync(workspaces[0]!.path)).toBe(true);
    expect(existsSync(workspaces[1]!.path)).toBe(true);
  });

  it("never reuses workspaces on retry (new run = new directories)", async () => {
    const { fixture, manager } = setup();
    const target = { targetId: "tgt-a", repositoryLocalPath: fixture.path, position: 0 };

    const first = await manager.createRunWorkspaces({
      taskId: "task-001",
      runId: "run-001",
      targets: [target],
    });
    const second = await manager.createRunWorkspaces({
      taskId: "task-001",
      runId: "run-002",
      targets: [target],
    });

    expect(first[0]?.path).not.toBe(second[0]?.path);
    expect(first[0]?.branch).toBe("ai/task-001-run-001-t0");
    expect(second[0]?.branch).toBe("ai/task-001-run-002-t0");
    expect(existsSync(first[0]!.path)).toBe(true);
    expect(existsSync(second[0]!.path)).toBe(true);
  });

  it("checks out the target baseRef when provided", async () => {
    const { fixture, manager } = setup();
    writeFileSync(join(fixture.path, "version.txt"), "v1\n");
    runGit(["add", "."], fixture.path);
    runGit(["commit", "-m", "v1"], fixture.path);
    runGit(["checkout", "-b", "release/2.1"], fixture.path);
    writeFileSync(join(fixture.path, "version.txt"), "v2\n");
    runGit(["commit", "-am", "v2"], fixture.path);
    runGit(["checkout", "main"], fixture.path);

    const workspaces = await manager.createRunWorkspaces({
      taskId: "task-002",
      runId: "run-001",
      targets: [
        { targetId: "tgt-main", repositoryLocalPath: fixture.path, position: 0 },
        {
          targetId: "tgt-release",
          repositoryLocalPath: fixture.path,
          position: 1,
          baseRef: "release/2.1",
        },
      ],
    });

    expect(readFileSync(join(workspaces[0]!.path, "version.txt"), "utf8").trim()).toBe("v1");
    expect(readFileSync(join(workspaces[1]!.path, "version.txt"), "utf8").trim()).toBe("v2");
  });

  it("cleans up every workspace of a run", async () => {
    const { fixture, manager } = setup();
    const workspaces = await manager.createRunWorkspaces({
      taskId: "task-003",
      runId: "run-001",
      targets: [
        { targetId: "tgt-a", repositoryLocalPath: fixture.path, position: 0 },
        { targetId: "tgt-b", repositoryLocalPath: fixture.path, position: 1 },
      ],
    });

    for (const workspace of workspaces) {
      await manager.removeWorkspace(workspace);
    }

    for (const workspace of workspaces) {
      expect(existsSync(workspace.path)).toBe(false);
    }
    expect(await manager.listWorktrees(fixture.path)).toHaveLength(1);
  });
});
