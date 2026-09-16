// Real-PostgreSQL integration test. Skipped by default so the unit suite
// stays offline; run explicitly against a migrated database:
//
//   npm run db:migrate
//   AI_TEST_POSTGRES=1 DATABASE_URL=postgres://ai:ai@localhost:5432/ai_harness \
//     npx vitest run tests/postgres.integration.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { CodexEngine } from "../src/agent/codexEngine.js";
import type { AgentContext, AgentEngine, AgentResult } from "../src/agent/types.js";
import { Loop } from "../src/loop/loop.js";
import { ProblemAnalyzer } from "../src/problem/analyzer.js";
import { ConfirmationLoop } from "../src/problem/confirmationLoop.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { PostgresRepositoryStore } from "../src/store/postgresRepositoryStore.js";
import { PostgresRunStore } from "../src/store/postgresRunStore.js";
import { PostgresTaskStore } from "../src/store/postgresTaskStore.js";
import { PostgresEventStore } from "../src/store/postgresEventStore.js";
import { PostgresProblemStore } from "../src/store/postgresProblemStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import {
  commitFile,
  createGitFixture,
  type GitFixture,
} from "./helpers/gitFixture.js";

const dbUrl = process.env.DATABASE_URL;
const enabled = process.env.AI_TEST_POSTGRES === "1" && Boolean(dbUrl);

const describePostgres = enabled ? describe : describe.skip;

const WRITE_CODE = [
  "process.stdin.resume();",
  "process.stdin.on('end', () => {",
  "  require('fs').writeFileSync('solution.txt', 'avatar upload implemented');",
  "  console.log('changes made');",
  "});",
].join("");

class QueueEngine implements AgentEngine {
  constructor(private readonly outputs: string[]) {}
  async execute(context: AgentContext): Promise<AgentResult> {
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: this.outputs.shift() ?? "",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
  async cancel(): Promise<void> {}
}

describePostgres("PostgreSQL integration", () => {
  const pool = enabled ? new Pool({ connectionString: dbUrl }) : null;
  const cleanups: (() => void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    await pool?.query(
      "DELETE FROM clarification_answers; DELETE FROM clarifications; DELETE FROM problem_analyses; DELETE FROM problems; DELETE FROM events; DELETE FROM workspaces; DELETE FROM runs; DELETE FROM tasks; DELETE FROM repositories;",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists repositories, tasks, runs and events end to end", async () => {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(fixture.path, "checks.sh", "test -f solution.txt && echo ok\n");
    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-workspaces-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    const repositories = new PostgresRepositoryStore(pool!);
    const tasks = new PostgresTaskStore(pool!);
    const runs = new PostgresRunStore(pool!);
    const events = new PostgresEventStore(pool!);

    const repo = await repositories.createRepository({
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
      localPath: fixture.path,
      verificationCommands: ["sh checks.sh"],
    });
    expect(repo.id).toBe("repo-001");

    const task = await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "Add user avatar",
      description: "Allow users to upload avatars.",
      status: "READY",
      acceptance: ["Tests pass"],
      maxAttempts: 3,
    });
    expect(task.status).toBe("READY");

    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager: new WorkspaceManager({ baseDir: workspaceBase }),
      agentEngine: new CodexEngine({
        executable: process.execPath,
        spawnArgs: () => ["-e", WRITE_CODE],
      }),
      verifier: new Verifier(),
      eventStore: events,
      workerId: "worker-pg",
      heartbeatMs: 50,
      leaseSeconds: 1,
    });
    const loop = new Loop({
      scheduler: new Scheduler({ taskStore: tasks, runStore: runs, eventStore: events }),
      worker,
      runStore: runs,
      taskStore: tasks,
      eventStore: events,
      maxConcurrency: 2,
    });

    const report = await loop.tick();
    expect(report.executed).toHaveLength(1);
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");
    expect((await runs.listRuns({ taskId: "task-001" }))[0]?.status).toBe("SUCCEEDED");

    const history = await events.listEvents({ taskId: "task-001" });
    const types = history.map((event) => event.type);
    expect(types).toEqual([
      "RunCreated",
      "RunStarted",
      "AgentStarted",
      "AgentFinished",
      "VerificationStarted",
      "VerificationPassed",
      "RunSucceeded",
      "TaskReview",
    ]);

    // In-memory reviewer + approval against the same Postgres task row.
    const inMemoryEvents = new InMemoryEventStore();
    const done = await tasks.updateTaskStatus("task-001", "DONE");
    await inMemoryEvents.record({ type: "TaskDone", taskId: "task-001" });
    expect(done.status).toBe("DONE");
    expect((await inMemoryEvents.listEvents()).map((e) => e.type)).toEqual(["TaskDone"]);
  });

  it("persists the problem confirmation data", async () => {
    const repositories = new PostgresRepositoryStore(pool!);
    const problems = new PostgresProblemStore(pool!);
    await repositories.createRepository({
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
      localPath: "/tmp/repos/my-app",
    });

    const problem = await problems.createProblem({
      id: "prob-001",
      repositoryId: "repo-001",
      title: "登录刷新后掉线",
      statement: "登录成功后，刷新页面变成未登录。",
    });
    expect(problem.status).toBe("INBOX");

    await problems.addAnalysis({
      problemId: "prob-001",
      summary: "需要确认影响范围",
      uncertainties: ["影响范围"],
      needsInput: true,
    });
    const clarification = await problems.createClarification({
      id: "clar-001",
      problemId: "prob-001",
      question: "是所有用户都会发生吗？",
      type: "fact",
      options: [
        { id: "all_users", label: "所有用户" },
        { id: "some_users", label: "部分用户" },
      ],
      reason: "决定是环境问题还是代码问题",
    });
    expect(clarification.status).toBe("OPEN");

    const answered = await problems.answerClarification("clar-001", {
      optionId: "all_users",
    });
    expect(answered.status).toBe("ANSWERED");
    expect(answered.answer?.optionId).toBe("all_users");

    const confirmed = await problems.setProblemSpec("prob-001", {
      problem: "刷新后登录状态丢失",
      expected: "刷新后仍保持登录",
      scope: "所有用户",
    });
    expect(confirmed.confirmedSpec?.expected).toBe("刷新后仍保持登录");
    expect((await problems.listClarifications("prob-001"))[0]?.answer?.optionId).toBe(
      "all_users",
    );
  });

  it("runs the confirmation loop and persists problem events", async () => {
    const problems = new PostgresProblemStore(pool!);
    const events = new PostgresEventStore(pool!);
    const needsInput = JSON.stringify({
      summary: "需要确认类型",
      needsInput: true,
      uncertainties: ["类型"],
      clarifications: [
        {
          question: "慢是指首屏还是操作？",
          type: "scope",
          required: true,
          options: [{ id: "initial", label: "首屏" }],
          reason: "调查路径不同",
        },
      ],
    });
    const sufficient = JSON.stringify({
      summary: "已明确",
      needsInput: false,
      uncertainties: [],
      clarifications: [],
    });
    const loop = new ConfirmationLoop({
      problems,
      events,
      analyzer: new ProblemAnalyzer(new QueueEngine([needsInput, sufficient])),
    });

    await problems.createProblem({ id: "prob-001", title: "t", statement: "s" });
    const first = await loop.analyze("prob-001");
    expect(first.problem.status).toBe("NEEDS_INPUT");
    const confirmed = await loop.answer("prob-001", first.clarifications[0]!.id, {
      optionId: "initial",
    });
    expect(confirmed.problem.status).toBe("CONFIRMED");

    const types = (await events.listEvents({ problemId: "prob-001" })).map(
      (event) => event.type,
    );
    expect(types).toEqual([
      "problem.analysis.updated",
      "problem.clarification.created",
      "problem.clarification.answered",
      "problem.analysis.updated",
      "problem.confirmed",
    ]);
  });
});
