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
import { PostgresExecutionStore } from "../src/store/postgresExecutionStore.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
} from "../src/execution/manager.js";
import { PostgresProblemStore } from "../src/store/postgresProblemStore.js";
import { PostgresConversationStore } from "../src/store/postgresConversationStore.js";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import { RunNotCancellableError } from "../src/errors.js";
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
      "DELETE FROM conversation_messages; DELETE FROM conversations; DELETE FROM clarification_answers; DELETE FROM clarifications; DELETE FROM problem_analyses; DELETE FROM problems; DELETE FROM events; DELETE FROM executions; DELETE FROM workspaces; DELETE FROM task_targets; DELETE FROM runs; DELETE FROM tasks; DELETE FROM repositories;",
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
    const executions = new PostgresExecutionStore(pool!);

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
      executionManager: new ExecutionManager({
        driver: new LocalExecutionDriver(),
        executions,
        events,
      }),
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
    const run = (await runs.listRuns({ taskId: "task-001" }))[0];
    expect(run?.status).toBe("SUCCEEDED");

    const history = await events.listEvents({ runId: run?.id });
    const types = history.map((event) => event.type);
    expect(types).toEqual([
      "RunCreated",
      "RunStarted",
      "execution.prepared",
      "AgentStarted",
      "AgentFinished",
      "VerificationStarted",
      "VerificationPassed",
      "RunSucceeded",
      "TaskReview",
      "execution.cleaned",
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
    const executionProfile = buildExecutionProfile({
      name: "frontend-node",
      image: "harness/node:22",
      network: { mode: "restricted", allow: ["registry.npmjs.org"] },
      resources: { cpus: 4 },
      secrets: ["GITHUB_TOKEN"],
    });
    await repositories.createRepository({
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
      localPath: "/tmp/repos/my-app",
      executionProfile,
    });
    expect((await repositories.findRepository("repo-001")).executionProfile).toEqual(
      executionProfile,
    );

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

  it("persists multi-repository task targets (TASK-1003)", async () => {
    const repositories = new PostgresRepositoryStore(pool!);
    const tasks = new PostgresTaskStore(pool!);
    await repositories.createRepository({
      id: "repo-a",
      name: "app",
      url: "git@github.com:example/app.git",
      localPath: "/tmp/repos/app",
    });
    await repositories.createRepository({
      id: "repo-b",
      name: "shared-lib",
      url: "git@github.com:example/shared-lib.git",
      localPath: "/tmp/repos/shared-lib",
    });

    const task = await tasks.createTask({
      id: "task-multi",
      title: "multi repo change",
      targets: [
        { taskId: "", repositoryId: "repo-b", role: "supporting", position: 1 },
        {
          taskId: "",
          repositoryId: "repo-a",
          role: "primary",
          position: 0,
          baseRef: "release/2.1",
        },
      ],
    });
    expect(task.repositoryId).toBe("repo-a");

    const loaded = await tasks.findTask("task-multi");
    expect(loaded.targets.map((target) => target.repositoryId)).toEqual([
      "repo-a",
      "repo-b",
    ]);
    expect(loaded.targets[0]).toMatchObject({
      role: "primary",
      position: 0,
      baseRef: "release/2.1",
      required: true,
    });
    expect(loaded.targets[1]).toMatchObject({
      role: "supporting",
      position: 1,
    });
    expect(
      (await tasks.listTasks({ repositoryId: "repo-a" }))[0]?.id,
    ).toBe("task-multi");
  });

  it("persists conversations with idempotent messages (TASK-1102)", async () => {
    const conversations = new PostgresConversationStore(pool!);
    const first = await conversations.ensureConversation({
      channel: "feishu",
      externalChatId: "chat-1",
      title: "Rehelu",
    });
    const again = await conversations.ensureConversation({
      channel: "feishu",
      externalChatId: "chat-1",
    });
    expect(again.id).toBe(first.id);

    const message = await conversations.appendMessage({
      conversationId: first.id,
      channel: "feishu",
      direction: "INBOUND",
      senderId: "user-1",
      content: "hello",
      externalMessageId: "message-001",
    });
    const retry = await conversations.appendMessage({
      conversationId: first.id,
      channel: "feishu",
      direction: "INBOUND",
      senderId: "user-1",
      content: "hello again",
      externalMessageId: "message-001",
    });
    expect(retry.id).toBe(message.id);
    expect(await conversations.findMessageByExternal("feishu", "message-001")).toMatchObject({
      id: message.id,
    });
    expect(await conversations.listMessages(first.id)).toHaveLength(1);

    await conversations.appendMessage({
      conversationId: first.id,
      channel: "feishu",
      direction: "OUTBOUND",
      senderId: "harness",
      content: "hi",
    });
    const linked = await conversations.attachSubject(first.id, {
      subjectType: "problem",
      subjectId: "PROB-018",
    });
    expect(linked.subjectType).toBe("problem");
    expect(await conversations.listMessages(first.id, { limit: 1 })).toMatchObject([
      { direction: "OUTBOUND", content: "hi" },
    ]);
  });

  it("persists run cancel requests (TASK-1108)", async () => {
    const repositories = new PostgresRepositoryStore(pool!);
    const tasks = new PostgresTaskStore(pool!);
    const runs = new PostgresRunStore(pool!);
    await repositories.createRepository({
      id: "repo-cancel",
      name: "app",
      url: "git@github.com:example/app.git",
      localPath: "/tmp/repos/app",
    });
    await tasks.createTask({
      id: "task-cancel",
      repositoryId: "repo-cancel",
      title: "cancel me",
      status: "READY",
    });
    await runs.createRun({
      id: "run-cancel",
      taskId: "task-cancel",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    await runs.claimRun("run-cancel", "worker-pg", "2099-01-01T00:00:00.000Z");
    await runs.markRunning("run-cancel");

    const requested = await runs.requestCancel("run-cancel", "feishu:ou_1");
    expect(requested.cancelRequestedAt).toBeDefined();
    expect(requested.cancelRequestedBy).toBe("feishu:ou_1");
    const retry = await runs.requestCancel("run-cancel", "feishu:ou_2");
    expect(retry.cancelRequestedBy).toBe("feishu:ou_1");
    expect(await runs.listRuns({ cancelRequested: true })).toMatchObject([
      { id: "run-cancel" },
    ]);

    await runs.completeRun("run-cancel", { status: "CANCELLED" });
    await expect(
      runs.requestCancel("run-cancel", "feishu:ou_1"),
    ).rejects.toBeInstanceOf(RunNotCancellableError);
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
