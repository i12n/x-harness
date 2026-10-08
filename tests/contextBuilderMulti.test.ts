import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentContext,
  type ContextTarget,
} from "../src/agent/contextBuilder.js";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import type { Repository } from "../src/domain/repository.js";
import type { Task } from "../src/domain/task.js";

function repository(id: string, name: string): Repository {
  return {
    id,
    name,
    url: `git@github.com:example/${name}.git`,
    defaultBranch: "main",
    localPath: `/repos/${name}`,
    verificationCommands: ["sh checks.sh"],
    executionProfile: buildExecutionProfile({ name: "acceptance", image: "img" }),
    createdAt: "",
    updatedAt: "",
  };
}

function task(): Task {
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
    title: "Add avatar upload",
    description: "Add avatar upload to the app and reuse the shared library.",
    status: "READY",
    priority: 50,
    acceptance: ["Avatar upload works", "Shared library builds"],
    constraints: { problemId: "prob-001" },
    maxAttempts: 3,
    createdAt: "",
    updatedAt: "",
  };
}

describe("Multi-repository Context Builder (TASK-1007)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function workspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-ctx-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  function targetsFor(
    workspaceA: string,
    workspaceB: string,
  ): ContextTarget[] {
    return [
      {
        targetId: "tgt-a",
        repository: repository("repo-a", "rehelu"),
        role: "primary",
        branch: "ai/task-001-run-001-t0",
        workdir: "/workspace",
        hostWorkspacePath: workspaceA,
      },
      {
        targetId: "tgt-b",
        repository: repository("repo-b", "auth"),
        role: "supporting",
        branch: "ai/task-001-run-001-t1",
        workdir: "/workspaces/tgt-b",
        hostWorkspacePath: workspaceB,
      },
    ];
  }

  it("builds a Targets section with repository, branch and workdir", async () => {
    const workspaceA = workspace({
      "AGENTS.md": "A-INSTRUCTIONS",
      "docs/a.md": "A-DOC",
    });
    const workspaceB = workspace({
      "PROJECT.md": "B-INSTRUCTIONS",
      "docs/b.md": "B-DOC",
    });

    const context = await buildAgentContext({
      runId: "run-001",
      task: task(),
      targets: targetsFor(workspaceA, workspaceB),
      primaryTargetId: "tgt-a",
    });

    expect(context.prompt).toContain("## Targets");
    expect(context.prompt).toContain("### Primary (rehelu)");
    expect(context.prompt).toContain("### Supporting (auth)");
    expect(context.prompt).toContain("Branch: ai/task-001-run-001-t0");
    expect(context.prompt).toContain("Branch: ai/task-001-run-001-t1");
    expect(context.prompt).toContain("Workdir: /workspace");
    expect(context.prompt).toContain("Workdir: /workspaces/tgt-b");
    expect(context.prompt).toContain("Acceptance criteria:");
    expect(context.prompt).toContain("- Avatar upload works");
  });

  it("keeps project context scoped per repository", async () => {
    const workspaceA = workspace({
      "AGENTS.md": "A-INSTRUCTIONS",
      "docs/a.md": "A-DOC-ONLY",
    });
    const workspaceB = workspace({
      "AGENTS.md": "B-INSTRUCTIONS",
      "docs/b.md": "B-DOC-ONLY",
    });

    const context = await buildAgentContext({
      runId: "run-001",
      task: task(),
      targets: targetsFor(workspaceA, workspaceB),
      primaryTargetId: "tgt-a",
    });

    expect(context.prompt).toContain("## Project Context");
    // TASK-1236: instructions are injected, documents are only indexed.
    for (const marker of ["A-INSTRUCTIONS", "B-INSTRUCTIONS", "docs/a.md", "docs/b.md"]) {
      expect(context.prompt).toContain(marker);
    }
    for (const content of ["A-DOC-ONLY", "B-DOC-ONLY"]) {
      expect(context.prompt).not.toContain(content);
    }
    // A's instructions appear under A's heading, before B's heading.
    const headingA = context.prompt.indexOf("### rehelu (tgt-a)");
    const instructionA = context.prompt.indexOf("A-INSTRUCTIONS");
    const headingB = context.prompt.indexOf("### auth (tgt-b)");
    const instructionB = context.prompt.indexOf("B-INSTRUCTIONS");
    expect(headingA).toBeGreaterThanOrEqual(0);
    expect(instructionA).toBeGreaterThan(headingA);
    expect(headingB).toBeGreaterThan(instructionA);
    expect(instructionB).toBeGreaterThan(headingB);
  });

  it("does not fail when a repository has no optional documents", async () => {
    const workspaceA = workspace({ "AGENTS.md": "A-INSTRUCTIONS" });
    const workspaceB = workspace({});

    const context = await buildAgentContext({
      runId: "run-001",
      task: task(),
      targets: targetsFor(workspaceA, workspaceB),
      primaryTargetId: "tgt-a",
    });

    expect(context.prompt).toContain("### auth (tgt-b)");
    expect(context.prompt).toContain("(no instruction files found)");
    expect(context.workspacePath).toBe(workspaceA);
    expect(context.repository?.id).toBe("repo-a");
  });

  it("bounds the total context size with a truncation marker", async () => {
    const huge = "x".repeat(200 * 1024);
    const workspaceA = workspace({ "AGENTS.md": huge });
    const workspaceB = workspace({ "AGENTS.md": "B-INSTRUCTIONS" });

    const context = await buildAgentContext({
      runId: "run-001",
      task: task(),
      targets: targetsFor(workspaceA, workspaceB),
      primaryTargetId: "tgt-a",
    });

    expect(context.prompt).toContain("[additional instruction files omitted due to size limit]");
    expect(context.prompt.length).toBeLessThan(120 * 1024);
    expect(context.prompt).toContain("B-INSTRUCTIONS");
  });

  it("keeps the single-repository prompt free of Targets/Project Context sections", async () => {
    const workspaceA = workspace({ "AGENTS.md": "A-INSTRUCTIONS" });

    const context = await buildAgentContext({
      runId: "run-001",
      task: task(),
      repository: repository("repo-a", "rehelu"),
      workspacePath: workspaceA,
    });

    expect(context.prompt).toContain("inside a dedicated git worktree");
    expect(context.prompt).toContain("Project instructions:");
    expect(context.prompt).not.toContain("## Targets");
  });
});
