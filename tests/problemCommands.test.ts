import { describe, expect, it } from "vitest";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import {
  confirmProblemCommand,
  convertProblemToTaskCommand,
  createProblemCommand,
  showProblemCommand,
} from "../src/cli/commands/problemCommands.js";
import { HarnessError } from "../src/errors.js";
import { ProblemAnalyzer } from "../src/problem/analyzer.js";
import { ConfirmationLoop } from "../src/problem/confirmationLoop.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { InMemoryProblemStore } from "../src/store/inMemoryProblemStore.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";
import { InMemoryTaskStore } from "../src/store/inMemoryTaskStore.js";

class NoopEngine implements AgentEngine {
  async execute(context: AgentContext): Promise<AgentResult> {
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
  async cancel(): Promise<void> {}
}

describe("problem CLI commands", () => {
  it("converts a confirmed problem into an executable Task", async () => {
    const problems = new InMemoryProblemStore();
    const tasks = new InMemoryTaskStore();
    const repositories = new InMemoryRepositoryStore();
    const events = new InMemoryEventStore();
    await repositories.createRepository({
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
    });
    const loop = new ConfirmationLoop({
      problems,
      repositories,
      events,
      analyzer: new ProblemAnalyzer(new NoopEngine()),
    });

    await createProblemCommand(
      problems,
      {
        id: "prob-001",
        title: "登录刷新后掉线",
        statement: "登录成功后，刷新页面变成未登录。",
        repo: "repo-001",
      },
      events,
    );
    await confirmProblemCommand(loop, "prob-001", {
      problem: "刷新后登录状态丢失",
      expected: "刷新后仍保持登录",
      scope: "所有用户",
      investigation: "检查 Token hydration",
    });

    const outcome = await convertProblemToTaskCommand({
      problems,
      tasks,
      repositories,
      events,
      problemId: "prob-001",
      repositoryId: "repo-001",
    });

    expect(outcome.task.status).toBe("INBOX");
    expect(outcome.task.repositoryId).toBe("repo-001");
    expect(outcome.task.title).toBe("登录刷新后掉线");
    expect(outcome.task.acceptance).toEqual(["刷新后仍保持登录"]);
    expect(outcome.task.constraints.problemId).toBe("prob-001");
    expect(outcome.task.description).toContain("刷新后登录状态丢失");
    expect(outcome.problem.status).toBe("READY");

    const types = (await events.listEvents({ problemId: "prob-001" })).map((e) => e.type);
    expect(types).toEqual([
      "problem.created",
      "problem.confirmed",
      "problem.specified",
      "problem.ready",
    ]);

    const detail = await showProblemCommand(problems, "prob-001");
    expect(detail.problem.confirmedSpec?.scope).toBe("所有用户");
  });

  it("refuses to convert a problem that is not confirmed", async () => {
    const problems = new InMemoryProblemStore();
    const tasks = new InMemoryTaskStore();
    const repositories = new InMemoryRepositoryStore();
    await repositories.createRepository({
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
    });
    await problems.createProblem({ id: "prob-001", title: "t", statement: "s" });

    await expect(
      convertProblemToTaskCommand({
        problems,
        tasks,
        repositories,
        problemId: "prob-001",
        repositoryId: "repo-001",
      }),
    ).rejects.toBeInstanceOf(HarnessError);
  });
});
