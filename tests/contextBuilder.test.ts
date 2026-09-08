import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentContext } from "../src/agent/contextBuilder.js";
import type { Repository } from "../src/domain/repository.js";
import type { Task } from "../src/domain/task.js";

describe("ContextBuilder", () => {
  it("assembles task, repository and project instructions into a prompt", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-harness-workspace-"));
    writeFileSync(join(workspace, "AGENTS.md"), "Do not touch unrelated modules.");
    const docs = join(workspace, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "architecture.md"), "Modular monolith.");

    const repository: Repository = {
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
      defaultBranch: "main",
      localPath: "/tmp/repo",
      verificationCommands: ["npm test"],
      createdAt: "",
      updatedAt: "",
    };
    const task: Task = {
      id: "task-001",
      repositoryId: "repo-001",
      title: "Add user avatar",
      description: "Allow users to upload avatars.",
      status: "READY",
      priority: 50,
      acceptance: ["JPG supported", "Tests pass"],
      constraints: {},
      maxAttempts: 3,
      createdAt: "",
      updatedAt: "",
    };

    const context = await buildAgentContext({
      runId: "run-001",
      task,
      repository,
      workspacePath: workspace,
    });

    expect(context.workspacePath).toBe(workspace);
    expect(context.prompt).toContain("Add user avatar");
    expect(context.prompt).toContain("Allow users to upload avatars.");
    expect(context.prompt).toContain("- JPG supported");
    expect(context.prompt).toContain("Do not touch unrelated modules.");
    expect(context.prompt).toContain("Modular monolith.");
    expect(context.prompt).toContain("my-app (git@github.com:example/my-app.git)");
  });
});
