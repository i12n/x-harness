import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionProfile } from "../../../src/domain/executionProfile.js";
import { extractFailureEvidence } from "../../../src/domain/failureEvidence.js";
import type { AgentContext, AgentEngine, AgentResult } from "../../../src/agent/types.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
} from "../../../src/execution/manager.js";
import { Loop } from "../../../src/loop/loop.js";
import { ScriptedProblemAnalyzer } from "../../../src/problem/application/analyzer.js";
import { ProblemService } from "../../../src/problem/application/service.js";
import { ConfirmationLoop } from "../../../src/problem/confirmationLoop.js";
import { ReviewService } from "../../../src/review/application/reviewService.js";
import { Scheduler } from "../../../src/scheduler/scheduler.js";
import { InMemoryExecutionStore } from "../../../src/store/inMemoryExecutionStore.js";
import { InMemoryRepositoryStore } from "../../../src/store/inMemoryRepositoryStore.js";
import { Verifier } from "../../../src/verification/runner.js";
import { Worker } from "../../../src/worker/worker.js";
import { WorkspaceManager } from "../../../src/workspace/manager.js";
import { commitFile, createGitFixture, runGit, type GitFixture } from "../../helpers/gitFixture.js";
import {
  SampleAgentEngine,
  SAMPLE_PROJECT_DIR,
  needsInputAnalysis,
  SUFFICIENT_ANALYSIS,
} from "../phase11/harness.js";
import { createPhase12Harness } from "./harness.js";

/**
 * TASK-1208 Step 3 — Phase 12 Acceptance Entry Point.
 *
 * One file that walks the whole delivery loop with the generic fixture
 * (tests/fixtures/sample-project/) and stops at the human release boundary:
 *
 *   Problem → Confirmation → Specification → Planning → Task DAG
 *     → Scheduler → Run/Workspace → Agent → Verification → REVIEW
 *     → Approval → DONE → Delivery → READY_FOR_RELEASE → Human Release
 *
 * This file does not re-test the details owned by the other phase12 suites; it
 * proves the stages compose. Conversation association, cancellation, retry and
 * resource gates stay covered by tests/e2e/phase11/* and tests/e2e/phase12/*.
 */
describe("Phase 12 Acceptance — generic delivery loop (TASK-1208)", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  /** sample-project fixture + the shared phase12 harness + execution wiring. */
  async function setup(
    options: { verificationCommands?: string[]; agent?: AgentEngine } = {},
  ) {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    cpSync(SAMPLE_PROJECT_DIR, fixture.path, { recursive: true });
    runGit(["add", "."], fixture.path);
    runGit(["commit", "-m", "sample-project fixture"], fixture.path);

    const workspaceBase = mkdtempSync(join(tmpdir(), "ai-acceptance-"));
    cleanups.push(() => rmSync(workspaceBase, { recursive: true, force: true }));

    // Shared Phase 12 wiring: Problem/Specification/Planning/DAG/Delivery +
    // command layer. It deliberately has no execution, which this file adds.
    const h = await createPhase12Harness();

    const repositories = new InMemoryRepositoryStore();
    await repositories.createRepository({
      id: "repo-a",
      name: "sample-project",
      url: "git@github.com:example/sample-project.git",
      localPath: fixture.path,
      verificationCommands: options.verificationCommands ?? ["node test/verify.js"],
      executionProfile: defaultExecutionProfile(),
    });

    const executions = new InMemoryExecutionStore();
    const workspaceManager = new WorkspaceManager({ baseDir: workspaceBase });
    const executionManager = new ExecutionManager({
      driver: new LocalExecutionDriver(),
      executions,
      events: h.events,
    });
    const engine = options.agent ?? new SampleAgentEngine();
    const worker = new Worker({
      runStore: h.runs,
      taskStore: h.tasks,
      repositoryStore: repositories,
      workspaceManager,
      agentEngine: engine,
      verifier: new Verifier(),
      executionManager,
      eventStore: h.events,
      workerId: "worker-acceptance",
      heartbeatMs: 25,
      leaseSeconds: 5,
    });
    const reviews = new ReviewService({ tasks: h.tasks, runs: h.runs, events: h.events });
    const loop = new Loop({
      scheduler: new Scheduler({
        taskStore: h.tasks,
        runStore: h.runs,
        eventStore: h.events,
        runnableTasks: h.dependencyService,
        maxConcurrency: 1,
      }),
      worker,
      runStore: h.runs,
      taskStore: h.tasks,
      eventStore: h.events,
      executions,
      executionManager,
      repositories,
      workspaceManager,
      maxConcurrency: 1,
    });

    /**
     * Operator boundary #1 (see docs/phase12-acceptance.md §6): planning
     * produces INBOX tasks and Phase 12 has no `task.ready` command, so the
     * operator flips them to READY. Same semantics as `ai task validate`.
     */
    const markReady = async (taskId: string) => {
      await h.tasks.updateTaskStatus(taskId, "READY");
    };

    /** Runs one task through the real Loop until it reaches REVIEW. */
    const runToReview = async (taskId: string) => {
      const report = await loop.tick();
      expect(report.scheduled.map((run) => run.taskId)).toEqual([taskId]);
      await expect(h.tasks.findTask(taskId)).resolves.toMatchObject({ status: "REVIEW" });
      const runs = await h.runs.listRuns({ taskId });
      return runs[runs.length - 1]!;
    };

    const approve = (taskId: string) =>
      reviews.approve(taskId, { channel: "cli", userId: "reviewer-1" });

    return { h, fixture, repositories, executions, engine, reviews, loop, markReady, runToReview, approve };
  }

  it("drives Problem → Specification → Planning → Run → REVIEW → DONE → READY_FOR_RELEASE → human release", async () => {
    const s = await setup();
    const { h } = s;

    // --- Problem → Confirmation ------------------------------------------------
    const created = await h.dispatch("problem.create", {
      title: "sample-project greet",
      statement: "sample-project needs a greet(name) implementation.",
    });
    expect(created.status).toBe("succeeded");
    const problem = (created.data as { problem: { id: string; status: string } }).problem;
    expect(problem.status).toBe("CONFIRMED");

    // Duplicate command delivery must not create a second Problem.
    await h.dispatch("problem.create", {
      title: "sample-project greet",
      statement: "sample-project needs a greet(name) implementation.",
    });
    await expect(h.problems.listProblems()).resolves.toHaveLength(1);

    // --- Specification --------------------------------------------------------
    const specification = await h.specificationService.createFromProblem({
      problemId: problem.id,
      requirements: ["A: implement greet", "B: keep the module shape"],
      acceptance: ["node test/verify.js passes"],
      targets: [{ repositoryId: "repo-a" }],
    });
    expect(specification.status).toBe("DRAFT");
    await expect(h.specificationService.markReady(specification.id)).resolves.toMatchObject({
      status: "READY",
    });

    // An unconfirmed Problem cannot produce a Specification, and an incomplete
    // draft cannot become READY.
    const inbox = await h.problems.createProblem({
      id: "prob-inbox",
      title: "unconfirmed",
      statement: "not confirmed yet",
    });
    await expect(
      h.specificationService.createFromProblem({ problemId: inbox.id }),
    ).rejects.toMatchObject({ code: "problem_not_confirmed" });
    const incomplete = await h.specificationService.createFromProblem({
      problemId: problem.id,
      acceptance: [],
      targets: [],
    });
    await expect(h.specificationService.markReady(incomplete.id)).rejects.toMatchObject({
      code: "specification_incomplete",
    });

    // --- Planning (1 Specification → N Tasks, Delivery auto-created) ----------
    const planned = await h.dispatch("spec.plan", { specificationId: specification.id });
    expect(planned.status).toBe("succeeded");
    const plan = planned.data as {
      specification: { status: string };
      tasks: { id: string; status: string; acceptance: string[] }[];
      replayed: boolean;
    };
    expect(plan.specification.status).toBe("PLANNED");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.map((task) => task.status)).toEqual(["INBOX", "INBOX"]);
    expect(plan.tasks[0]?.acceptance).toEqual(["node test/verify.js passes"]);
    // Planning never executes: no Run exists yet.
    await expect(h.runs.listRuns()).resolves.toEqual([]);
    const delivery = (await h.deliveryService.findBySpecification(specification.id))!;
    expect(delivery).toBeDefined();

    // Replaying the same planning returns the same tasks.
    const replay = await h.dispatch("spec.plan", { specificationId: specification.id }, {
      messageId: "msg-plan-2",
    });
    expect(replay.status).toBe("succeeded");
    expect((replay.data as { replayed: boolean }).replayed).toBe(true);
    expect((replay.data as { tasks: { id: string }[] }).tasks.map((task) => task.id)).toEqual(
      plan.tasks.map((task) => task.id),
    );

    // --- DAG: B waits for A ---------------------------------------------------
    const [taskA, taskB] = plan.tasks;
    await s.markReady(taskA!.id);
    await s.markReady(taskB!.id);
    await h.dependencyService.addDependency(taskB!.id, taskA!.id);
    await expect(h.dependencyService.isRunnable(taskB!.id)).resolves.toBe(false);
    await expect(h.dependencyService.getImpact(taskB!.id)).resolves.toMatchObject({
      waiting: true,
      dependencyBlocked: false,
    });

    // --- Scheduler → Run → Workspace → Agent → Verification → REVIEW ----------
    const runA = await s.runToReview(taskA!.id);
    expect(runA.status).toBe("SUCCEEDED");
    expect(s.engine.calls).toBe(1); // one agent execution per Run
    const workspaceA = (runA.result as { workspaces: { path: string; targetId: string }[] })
      .workspaces[0]!;
    expect(workspaceA.path).toContain("task-");
    // Successful runs keep their workspace as the review artifact.
    expect(await s.h.runs.listRuns({ taskId: taskB!.id })).toEqual([]);
    const verification = (runA.result as { targets: { passed: boolean; checks: { status: string }[] }[] })
      .targets[0]!;
    expect(verification.passed).toBe(true);
    expect(verification.checks[0]?.status).toBe("passed");

    // --- Approval: REVIEW → DONE, which unlocks the dependent task -------------
    await s.approve(taskA!.id);
    await expect(h.tasks.findTask(taskA!.id)).resolves.toMatchObject({ status: "DONE" });
    await expect(h.dependencyService.isRunnable(taskB!.id)).resolves.toBe(true);

    const runB = await s.runToReview(taskB!.id);
    expect(runB.status).toBe("SUCCEEDED");
    const workspaceB = (runB.result as { workspaces: { path: string }[] }).workspaces[0]!;
    expect(workspaceB.path).not.toBe(workspaceA.path);
    await s.approve(taskB!.id);

    // --- Delivery: every required task DONE → READY_FOR_RELEASE ---------------
    const ready = await h.deliveryService.show(delivery.id);
    expect(ready.delivery.status).toBe("READY_FOR_RELEASE");
    expect(ready.requiredTasks).toHaveLength(2);
    expect(ready.blockingFacts).toEqual([]);

    // No automation may release: repeated ticks keep it waiting for a human.
    await s.loop.tick();
    await s.loop.tick();
    await expect(h.deliveries.findDelivery(delivery.id)).resolves.toMatchObject({
      status: "READY_FOR_RELEASE",
    });
    await expect(h.deliveries.listReleases(delivery.id)).resolves.toEqual([]);

    // --- Human release boundary ----------------------------------------------
    const released = await h.dispatch(
      "delivery.release",
      { deliveryId: delivery.id },
      { roles: ["reviewer"], senderId: "reviewer-1" },
    );
    expect(released.status).toBe("succeeded");
    const releaseData = released.data as {
      delivery: { status: string };
      release: { id: string; status: string; createdBy?: string };
      created: boolean;
    };
    expect(releaseData.created).toBe(true);
    expect(releaseData.delivery.status).toBe("RELEASED");
    expect(releaseData.release).toMatchObject({
      status: "RELEASED",
      createdBy: "cli:reviewer-1",
    });

    // Repeating the release is idempotent: one Release record, created=false.
    const repeat = await h.dispatch(
      "delivery.release",
      { deliveryId: delivery.id },
      { roles: ["reviewer"], senderId: "reviewer-2", messageId: "msg-release-2" },
    );
    expect(repeat.status).toBe("succeeded");
    expect((repeat.data as { created: boolean }).created).toBe(false);
    const releases = await h.deliveries.listReleases(delivery.id);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.id).toBe(releaseData.release.id);
    // Guests may not release.
    await expect(
      h.dispatch("delivery.release", { deliveryId: delivery.id }, {
        roles: ["guest"],
        messageId: "msg-release-guest",
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unauthorized" } });
  });

  it("covers the clarification path before the specification exists", async () => {
    const h = await createPhase12Harness();

    // The shared harness ships a "sufficient" scripted analyzer; a needs-input
    // round is wired here with the same production classes so the acceptance
    // file can prove Confirmation → Clarification → CONFIRMED end to end.
    const loop = new ConfirmationLoop({
      problems: h.problems,
      analyzer: new ScriptedProblemAnalyzer([needsInputAnalysis(), SUFFICIENT_ANALYSIS]),
      events: h.events,
    });
    const problems = new ProblemService(h.problems, loop);

    const created = await problems.create({
      title: "sample-project behaviour",
      statement: "Which behaviour is expected from greet()?",
    });
    expect(created.problem.status).toBe("NEEDS_INPUT");
    expect(created.clarifications).toHaveLength(1);
    const clarification = created.clarifications[0]!;
    expect(clarification.required).toBe(true);

    const answered = await problems.answer(created.problem.id, clarification.id, {
      optionId: "all_users",
    });
    expect(answered.problem.status).toBe("CONFIRMED");
    expect(answered.needsInput).toBe(false);

    // Only now can a Specification be derived from the confirmed Problem.
    const specification = await h.specificationService.createFromProblem({
      problemId: created.problem.id,
      requirements: ["A: implement greet"],
      acceptance: ["node test/verify.js passes"],
      targets: [{ repositoryId: "repo-a" }],
    });
    await expect(h.specificationService.markReady(specification.id)).resolves.toMatchObject({
      status: "READY",
    });
  });

  it("gates a fan-in task until every prerequisite is DONE and rejects cycles", async () => {
    const s = await setup();
    const { h } = s;

    const specification = await h.seedReadySpecification({
      requirements: ["A: greet", "B: module shape", "C: docs"],
    });
    const planned = await h.planning.plan(specification.id);
    const [taskA, taskB, taskC] = planned.tasks;
    for (const task of planned.tasks) {
      await s.markReady(task.id);
    }
    await h.dependencyService.addDependency(taskC!.id, taskA!.id);
    await h.dependencyService.addDependency(taskC!.id, taskB!.id);

    // C waits for both prerequisites; neither ordering unlocks it early.
    await expect(h.dependencyService.isRunnable(taskC!.id)).resolves.toBe(false);
    await s.runToReview(taskA!.id);
    await s.approve(taskA!.id);
    await expect(h.dependencyService.isRunnable(taskC!.id)).resolves.toBe(false);
    await expect(
      h.dependencyService.getImpact(taskC!.id),
    ).resolves.toMatchObject({ waiting: true, dependencyBlocked: false });

    await s.runToReview(taskB!.id);
    await s.approve(taskB!.id);
    await expect(h.dependencyService.isRunnable(taskC!.id)).resolves.toBe(true);

    // A cycle back into an existing edge is rejected (no illegal DAG).
    await expect(
      h.dependencyService.addDependency(taskA!.id, taskC!.id),
    ).rejects.toMatchObject({ code: "task_dependency_cycle" });
    await expect(h.dependencies.listAllDependencies()).resolves.toHaveLength(2);

    // The scheduler runs C last, in one agent execution, and the delivery is
    // not ready until C is approved too.
    const runC = await s.runToReview(taskC!.id);
    expect(runC.status).toBe("SUCCEEDED");
    const delivery = (await h.deliveryService.findBySpecification(specification.id))!;
    await expect(h.deliveryService.show(delivery.id)).resolves.toMatchObject({
      delivery: { status: "IN_PROGRESS" },
    });
    await s.approve(taskC!.id);
    await expect(h.deliveryService.show(delivery.id)).resolves.toMatchObject({
      delivery: { status: "READY_FOR_RELEASE" },
    });
    expect(await h.deliveries.listReleases(delivery.id)).toEqual([]);
  });

  it("request_changes returns the task to READY without creating a Run", async () => {
    const s = await setup();
    const { h } = s;

    const specification = await h.seedReadySpecification({ requirements: ["A: greet"] });
    const planned = await h.planning.plan(specification.id);
    const [taskA] = planned.tasks;
    await s.markReady(taskA!.id);

    await s.runToReview(taskA!.id);
    const runsAfterFirstAttempt = await h.runs.listRuns({ taskId: taskA!.id });
    expect(runsAfterFirstAttempt).toHaveLength(1);

    const changed = await s.reviews.requestChanges(
      taskA!.id,
      { channel: "cli", userId: "reviewer-1" },
      "please add tests",
    );
    expect(changed.status).toBe("READY");
    // Review only records a decision: the next Run is the scheduler's job.
    await expect(h.runs.listRuns({ taskId: taskA!.id })).resolves.toHaveLength(1);

    const retry = await s.loop.tick();
    expect(retry.scheduled.map((run) => run.taskId)).toEqual([taskA!.id]);
    await expect(h.runs.listRuns({ taskId: taskA!.id })).resolves.toHaveLength(2);
    await expect(h.tasks.findTask(taskA!.id)).resolves.toMatchObject({ status: "REVIEW" });
  });

  it("aggregates the three fixture checks when every one passes", async () => {
    const checks = [
      "node scripts/lint.js",
      "node test/verify.js",
      "node scripts/build.js",
    ];
    const s = await setup({ verificationCommands: checks });
    const { h } = s;

    const specification = await h.seedReadySpecification({ requirements: ["A: greet"] });
    const planned = await h.planning.plan(specification.id);
    const [taskA] = planned.tasks;
    await s.markReady(taskA!.id);

    const run = await s.runToReview(taskA!.id);

    expect(run.status).toBe("SUCCEEDED");
    const target = (run.result as {
      targets: { passed: boolean; checks: { command: string; status: string; output?: string }[] }[];
    }).targets[0]!;
    expect(target.passed).toBe(true);
    // Every configured check ran, in order, and each result is preserved.
    expect(target.checks.map((check) => check.command)).toEqual(checks);
    expect(target.checks.map((check) => check.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    // A successful run records no error block.
    expect(run.error).toBeUndefined();
    await expect(h.tasks.findTask(taskA!.id)).resolves.toMatchObject({ status: "REVIEW" });
  });

  it("keeps every check result and the failure evidence when one check fails", async () => {
    const checks = [
      "node scripts/lint.js",
      "node test/verify.js",
      "node scripts/build.js",
    ];
    // The fixture produces the failure: a wrong implementation passes lint and
    // build (the export exists) but fails the behaviour test.
    const s = await setup({ verificationCommands: checks, agent: new WrongImplementationAgent() });
    const { h } = s;

    const specification = await h.seedReadySpecification({ requirements: ["A: greet"] });
    const planned = await h.planning.plan(specification.id);
    const [taskA] = planned.tasks;
    await s.markReady(taskA!.id);

    const report = await s.loop.tick();
    expect(report.scheduled.map((run) => run.taskId)).toEqual([taskA!.id]);
    const runs = await h.runs.listRuns({ taskId: taskA!.id });
    const run = runs[runs.length - 1]!;
    expect(run.status).toBe("FAILED");
    // Attempts remain, so the existing retry policy returns the task to READY.
    await expect(h.tasks.findTask(taskA!.id)).resolves.toMatchObject({ status: "READY" });

    const verification = (run.error as {
      verification: { command: string; status: string; exitCode: number | null; output: string }[];
    }).verification;
    // All three checks are reported even though the middle one failed.
    expect(verification.map((check) => check.command)).toEqual(checks);
    expect(verification.map((check) => check.status)).toEqual([
      "passed",
      "failed",
      "passed",
    ]);
    const failing = verification[1]!;
    expect(failing.exitCode).toBe(1);
    expect(failing.output.length).toBeGreaterThan(0);
    // The passing checks still carry their own evidence.
    expect(verification[0]?.output).toContain("lint ok");
    expect(verification[2]?.output).toContain("build ok");
    // Per-target evidence mirrors the same run facts.
    const failingTarget = (run.error as {
      failingTargets: { repositoryId: string; checks: { command: string; status: string }[] }[];
    }).failingTargets[0]!;
    expect(failingTarget.repositoryId).toBe("repo-a");
    expect(failingTarget.checks.map((check) => check.status)).toEqual([
      "passed",
      "failed",
      "passed",
    ]);

    // The Phase A evidence extractor reads the same persisted facts.
    expect(extractFailureEvidence(run)).toMatchObject({
      kind: "verification",
      command: "node test/verify.js",
      exitCode: 1,
    });
  });
});

/**
 * Writes a `greet` implementation with the wrong behaviour: `lint` and `build`
 * still pass (the export exists), only the behaviour check fails — the fixture
 * itself produces the failure, so Harness verification code stays untouched.
 */
class WrongImplementationAgent implements AgentEngine {
  async execute(context: AgentContext): Promise<AgentResult> {
    const exec = context.execution?.exec;
    if (!exec) {
      throw new Error("wrong-implementation agent requires execution.exec");
    }
    const source = [
      "function greet(name) {",
      "  return `Hi, ${name}!`;",
      "}",
      "",
      "module.exports = { greet };",
      "",
    ].join("\n");
    for (const workdir of Object.values(context.execution?.workdirs ?? {})) {
      const result = await exec(
        ["sh", "-lc", `cat > src/index.js <<'EOF'\n${source}EOF`],
        { cwd: workdir },
      );
      if (result.exitCode !== 0) {
        throw new Error(`wrong-implementation write failed: ${result.stderr}`);
      }
    }
    const now = new Date().toISOString();
    return {
      runId: context.runId,
      exitCode: 0,
      signal: undefined,
      stdout: "wrote a wrong implementation",
      stderr: "",
      startedAt: now,
      finishedAt: now,
    };
  }

  async cancel(): Promise<void> {}
}
