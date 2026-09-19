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
import { PostgresSpecificationStore } from "../src/store/postgresSpecificationStore.js";
import { PostgresSpecificationPlanStore } from "../src/store/postgresSpecificationPlanStore.js";
import { PostgresTaskDependencyStore } from "../src/store/postgresTaskDependencyStore.js";
import { TaskDependencyService } from "../src/task/application/dependencyService.js";
import { SpecificationService } from "../src/specification/application/service.js";
import { PlanningService } from "../src/specification/application/planning.js";
import { DeterministicTaskPlanner } from "../src/specification/application/planner.js";
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
      "DELETE FROM conversation_messages; DELETE FROM conversations; DELETE FROM specification_plans; DELETE FROM specification_targets; DELETE FROM specifications; DELETE FROM clarification_answers; DELETE FROM clarifications; DELETE FROM problem_analyses; DELETE FROM problems; DELETE FROM events; DELETE FROM executions; DELETE FROM workspaces; DELETE FROM task_dependencies; DELETE FROM task_targets; DELETE FROM runs; DELETE FROM tasks; DELETE FROM repositories;",
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

  it("persists specifications derived from a confirmed problem (TASK-1201)", async () => {
    const repositories = new PostgresRepositoryStore(pool!);
    const problems = new PostgresProblemStore(pool!);
    const specifications = new PostgresSpecificationStore(pool!);
    const events = new PostgresEventStore(pool!);
    const service = new SpecificationService({ specifications, problems, events });

    for (const id of ["repo-a", "repo-b"]) {
      await repositories.createRepository({
        id,
        name: id,
        url: `git@github.com:example/${id}.git`,
        localPath: `/tmp/repos/${id}`,
      });
    }
    await problems.createProblem({
      id: "prob-001",
      title: "专辑页面",
      statement: "用户希望有一个专辑页面。",
      status: "CONFIRMED",
    });
    await problems.setProblemSpec("prob-001", {
      problem: "专辑页面不存在",
      expected: "可以浏览专辑曲目",
      scope: "所有用户",
    });

    const specification = await service.createFromProblem({
      problemId: "prob-001",
      acceptance: ["可以打开专辑页"],
      targets: [
        { repositoryId: "repo-a", baseRef: "main" },
        { repositoryId: "repo-b", baseRef: "develop" },
      ],
    });
    expect(specification.status).toBe("DRAFT");

    const ready = await service.markReady(specification.id);
    expect(ready.status).toBe("READY");

    const reloaded = await specifications.findSpecification(specification.id);
    expect(reloaded.targets).toEqual([
      { repositoryId: "repo-a", role: "primary", position: 0, baseRef: "main" },
      { repositoryId: "repo-b", role: "supporting", position: 1, baseRef: "develop" },
    ]);
    expect(reloaded.acceptance).toEqual(["可以打开专辑页"]);
    expect(reloaded.constraints).toEqual({ scope: "所有用户" });

    const updated = await specifications.updateSpecification(specification.id, {
      summary: "新的摘要",
      targets: [{ repositoryId: "repo-b", baseRef: "release" }],
    });
    expect(updated.targets).toEqual([
      { repositoryId: "repo-b", role: "primary", position: 0, baseRef: "release" },
    ]);
    expect(updated.summary).toBe("新的摘要");

    await expect(
      specifications.findSpecificationByProblem("prob-001"),
    ).resolves.toMatchObject({ id: specification.id });
    await expect(
      specifications.findSpecificationByProblem("prob-missing"),
    ).resolves.toBeUndefined();
    await expect(
      specifications.findSpecification("spec-missing"),
    ).rejects.toThrow(/specification not found/);

    const types = (await events.listEvents({ problemId: "prob-001" })).map(
      (event) => event.type,
    );
    expect(types).toEqual(["specification.created", "specification.ready"]);
  });

  it("plans a READY specification into tasks once (TASK-1202)", async () => {
    const repositories = new PostgresRepositoryStore(pool!);
    const problems = new PostgresProblemStore(pool!);
    const specifications = new PostgresSpecificationStore(pool!);
    const plans = new PostgresSpecificationPlanStore(pool!);
    const tasks = new PostgresTaskStore(pool!);
    const events = new PostgresEventStore(pool!);
    const specificationService = new SpecificationService({
      specifications,
      problems,
      events,
    });
    const planning = new PlanningService({
      specifications,
      plans,
      tasks,
      planner: new DeterministicTaskPlanner(),
      events,
    });

    for (const id of ["repo-a", "repo-b"]) {
      await repositories.createRepository({
        id,
        name: id,
        url: `git@github.com:example/${id}.git`,
        localPath: `/tmp/repos/${id}`,
      });
    }
    await problems.createProblem({
      id: "prob-001",
      title: "专辑页面",
      statement: "用户希望有一个专辑页面。",
      status: "CONFIRMED",
    });
    await problems.setProblemSpec("prob-001", {
      problem: "专辑页面不存在",
      expected: "可以浏览专辑曲目",
    });

    const specification = await specificationService.createFromProblem({
      problemId: "prob-001",
      requirements: ["列表页显示曲目", "详情页显示歌词"],
      acceptance: ["可以打开专辑页"],
      targets: [{ repositoryId: "repo-a" }, { repositoryId: "repo-b" }],
    });
    await specificationService.markReady(specification.id);

    const first = await planning.plan(specification.id);
    expect(first.replayed).toBe(false);
    expect(first.specification.status).toBe("PLANNED");
    expect(first.tasks.map((task) => task.id)).toEqual([
      `task-${specification.id}-0`,
      `task-${specification.id}-1`,
    ]);
    expect(first.tasks[0]?.status).toBe("INBOX");
    expect(first.tasks[0]?.targets.map((target) => target.repositoryId)).toEqual([
      "repo-a",
      "repo-b",
    ]);

    const reloaded = await plans.listPlanItems(specification.id);
    expect(reloaded.map((item) => item.taskId)).toEqual(
      first.tasks.map((task) => task.id),
    );
    expect((await tasks.listTasks()).length).toBe(2);

    // Second planning is a replay, not a second batch of tasks.
    const second = await planning.plan(specification.id);
    expect(second.replayed).toBe(true);
    expect(second.tasks.map((task) => task.id)).toEqual(
      first.tasks.map((task) => task.id),
    );
    expect((await tasks.listTasks()).length).toBe(2);

    // The DB backstop: one plan item per (specification, position).
    await expect(
      plans.createPlanItem({
        specificationId: specification.id,
        position: 0,
        title: "duplicate",
      }),
    ).rejects.toThrow(/already has a plan item at position 0/);

    // Compare-and-set status guard (READY → PLANNED once).
    await expect(
      specifications.updateSpecificationStatusIf(specification.id, "READY", "PLANNED"),
    ).resolves.toBeUndefined();
    await expect(
      specifications.updateSpecificationStatusIf(specification.id, "PLANNED", "READY"),
    ).resolves.toMatchObject({ status: "READY" });

    const planned = await events.listEvents({ type: "specification.planned" });
    expect(planned).toHaveLength(1);
  });

  it("persists task dependencies with DB-level graph guards (TASK-1203)", async () => {
    const repositories = new PostgresRepositoryStore(pool!);
    const tasks = new PostgresTaskStore(pool!);
    const dependencies = new PostgresTaskDependencyStore(pool!);
    const events = new PostgresEventStore(pool!);
    const service = new TaskDependencyService({ tasks, dependencies, events });

    await repositories.createRepository({
      id: "repo-a",
      name: "app",
      url: "git@github.com:example/app.git",
      localPath: "/tmp/repos/app",
    });
    for (const id of ["task-a", "task-b", "task-c"]) {
      await tasks.createTask({
        id,
        repositoryId: "repo-a",
        title: id,
        status: "READY",
      });
    }

    const first = await service.addDependency("task-c", "task-a");
    expect(first.created).toBe(true);
    await service.addDependency("task-c", "task-b");
    expect((await dependencies.listDependencies("task-c")).map((edge) => edge.dependsOnTaskId))
      .toEqual(["task-a", "task-b"]);
    expect((await service.listDependents("task-a")).map((task) => task.id)).toEqual([
      "task-c",
    ]);

    // Duplicate add is idempotent at the service layer…
    const again = await service.addDependency("task-c", "task-a");
    expect(again.created).toBe(false);
    expect(await dependencies.listAllDependencies()).toHaveLength(2);

    // …and the PRIMARY KEY is the backstop when the service is bypassed.
    await expect(
      pool!.query(
        "INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES ('task-c', 'task-a', now())",
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // CHECK(task_id <> depends_on_task_id) is the self-edge backstop.
    await expect(
      pool!.query(
        "INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES ('task-a', 'task-a', now())",
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Cycle rejection (transitive): c → a exists, so a → c must fail.
    await expect(service.addDependency("task-a", "task-c")).rejects.toMatchObject({
      code: "task_dependency_cycle",
    });
    await expect(service.addDependency("task-a", "task-a")).rejects.toMatchObject({
      code: "task_dependency_self",
    });

    // Runnable predicate: only DONE satisfies a dependency.
    await expect(service.isRunnable("task-c")).resolves.toBe(false);
    await tasks.updateTaskStatus("task-a", "DONE");
    await tasks.updateTaskStatus("task-b", "REVIEW");
    await expect(service.isRunnable("task-c")).resolves.toBe(false);
    await tasks.updateTaskStatus("task-b", "DONE");
    await expect(service.isRunnable("task-c")).resolves.toBe(true);
    expect((await service.listRunnableTasks()).map((task) => task.id)).toEqual([
      "task-c",
    ]);

    const added = await events.listEvents({ type: "task.dependency.added" });
    expect(added).toHaveLength(2);
    expect(added[0]?.taskId).toBe("task-c");
  });

  it("schedules DAG-aware and never double-creates a run (TASK-1204)", async () => {
    const repositories = new PostgresRepositoryStore(pool!);
    const tasks = new PostgresTaskStore(pool!);
    const runs = new PostgresRunStore(pool!);
    const dependencies = new PostgresTaskDependencyStore(pool!);
    const events = new PostgresEventStore(pool!);
    const dependencyService = new TaskDependencyService({ tasks, dependencies, events });

    await repositories.createRepository({
      id: "repo-a",
      name: "app",
      url: "git@github.com:example/app.git",
      localPath: "/tmp/repos/app",
    });
    for (const id of ["task-a", "task-b"]) {
      await tasks.createTask({
        id,
        repositoryId: "repo-a",
        title: id,
        status: "READY",
      });
    }
    await dependencyService.addDependency("task-b", "task-a");

    const scheduler = new Scheduler({
      taskStore: tasks,
      runStore: runs,
      maxConcurrency: 2,
      runnableTasks: dependencyService,
    });
    const first = await scheduler.schedule();
    expect(first.map((run) => run.taskId)).toEqual(["task-a"]);

    // A busy task is never scheduled twice.
    await expect(scheduler.schedule()).resolves.toHaveLength(0);
    expect(await runs.listRuns({ taskId: "task-a" })).toHaveLength(1);

    // A SUCCEEDED run alone does not unlock B: the Task has to reach DONE
    // (review/approval); until then A itself is runnable again.
    await runs.completeRun(first[0]!.id, { status: "SUCCEEDED", exitCode: 0 });
    const notApprovedYet = await scheduler.schedule();
    expect(notApprovedYet.map((run) => run.taskId)).toEqual(["task-a"]);
    await runs.completeRun(notApprovedYet[0]!.id, { status: "SUCCEEDED", exitCode: 0 });

    await tasks.updateTaskStatus("task-a", "DONE");
    const afterDone = await scheduler.schedule();
    expect(afterDone.map((run) => run.taskId)).toEqual(["task-b"]);

    // Direct inserts cannot bypass the DB guard either.
    await expect(
      pool!.query(
        `INSERT INTO runs (id, task_id, status, attempt, agent, engine, created_at)
         VALUES ('run-dup', 'task-b', 'QUEUED', 2, 'codex', 'codex', now())`,
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await runs.completeRun(afterDone[0]!.id, { status: "SUCCEEDED", exitCode: 0 });
    await expect(
      runs.createRun({
        id: "run-retry",
        taskId: "task-b",
        attempt: 2,
        agent: "codex",
        engine: "codex",
      }),
    ).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("two schedulers racing create exactly one run (TASK-1204)", async () => {
    const repositories = new PostgresRepositoryStore(pool!);
    const tasks = new PostgresTaskStore(pool!);
    const runs = new PostgresRunStore(pool!);
    const dependencies = new PostgresTaskDependencyStore(pool!);
    const events = new PostgresEventStore(pool!);
    const dependencyService = new TaskDependencyService({ tasks, dependencies, events });

    await repositories.createRepository({
      id: "repo-a",
      name: "app",
      url: "git@github.com:example/app.git",
      localPath: "/tmp/repos/app",
    });
    await tasks.createTask({
      id: "task-race",
      repositoryId: "repo-a",
      title: "race",
      status: "READY",
    });

    const schedulerA = new Scheduler({
      taskStore: tasks,
      runStore: runs,
      maxConcurrency: 1,
      runnableTasks: dependencyService,
    });
    const schedulerB = new Scheduler({
      taskStore: tasks,
      runStore: runs,
      maxConcurrency: 1,
      runnableTasks: dependencyService,
    });

    const [left, right] = await Promise.all([
      schedulerA.schedule(),
      schedulerB.schedule(),
    ]);

    expect(left.length + right.length).toBe(1);
    const created = await runs.listRuns({ taskId: "task-race" });
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe("QUEUED");
  });
});
