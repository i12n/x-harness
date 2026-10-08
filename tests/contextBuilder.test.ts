import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentContext } from "../src/agent/contextBuilder.js";
import type { Repository } from "../src/domain/repository.js";
import type { Task } from "../src/domain/task.js";

const repository = (): Repository => ({
  id: "repo-001",
  name: "my-app",
  url: "git@github.com:example/my-app.git",
  defaultBranch: "main",
  localPath: "/tmp/repo",
  verificationCommands: ["npm test"],
  createdAt: "",
  updatedAt: "",
});

const task = (): Task => ({
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
});

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
    // TASK-1236: the docs tree is an index, not payload — its contents cost
    // ~87k tokens per model call and the agent can read the file itself.
    expect(context.prompt).toContain("docs/architecture.md");
    expect(context.prompt).not.toContain("Modular monolith.");
    expect(context.prompt).toContain("my-app (git@github.com:example/my-app.git)");
  });

  it("keeps a large documentation tree out of the prompt (TASK-1236)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-harness-workspace-"));
    writeFileSync(join(workspace, "AGENTS.md"), "Keep it small.");
    const docs = join(workspace, "docs");
    mkdirSync(docs);
    // The live x-music tree is ~484 KB of markdown; it used to be pasted into
    // every model call (29 calls × ~87k tokens for a one-line change).
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(
        join(docs, `doc-${index}.md`),
        `# doc ${index}\n${"中文文档内容。".repeat(1000)}\n`,
      );
    }

    const context = await buildAgentContext({
      runId: "run-002",
      task: task(),
      repository: repository(),
      workspacePath: workspace,
    });

    expect(context.prompt).toContain("docs/doc-7.md");
    expect(context.prompt).not.toContain("中文文档内容。中文文档内容。");
    // Instructions + index only: the order of magnitude is what matters here.
    expect(Buffer.byteLength(context.prompt, "utf8")).toBeLessThan(8 * 1024);
  });
});
