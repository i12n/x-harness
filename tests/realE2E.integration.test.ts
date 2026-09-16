// v0.1 封版验收：真实 PostgreSQL + 真实 Codex，全链路一次跑通。
//
// 默认跳过（普通单测保持离线）；显式开启：
//
//   pg_ctl -D /tmp/ai-pg/data -o '-p 5432 -k /tmp/ai-pg' start
//   DATABASE_URL=postgres://ai@localhost:5432/ai_harness npm run test:e2e:real

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { CodexEngine } from "../src/agent/codexEngine.js";
import { cleanupWorkspacesCommand } from "../src/cli/commands/workspaceCommands.js";
import { Loop } from "../src/loop/loop.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { PostgresEventStore } from "../src/store/postgresEventStore.js";
import { PostgresRepositoryStore } from "../src/store/postgresRepositoryStore.js";
import { PostgresRunStore } from "../src/store/postgresRunStore.js";
import { PostgresTaskStore } from "../src/store/postgresTaskStore.js";
import { Verifier } from "../src/verification/runner.js";
import { Worker } from "../src/worker/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import {
  commitFile,
  createGitFixture,
  type GitFixture,
} from "./helpers/gitFixture.js";

const dbUrl = process.env.DATABASE_URL;
const enabled =
  process.env.AI_TEST_POSTGRES === "1" &&
  process.env.AI_TEST_CODEX === "1" &&
  Boolean(dbUrl);

const describeReal = enabled ? describe : describe.skip;

describeReal("v0.1 seal: real Postgres + real Codex end to end", () => {
  const pool = enabled ? new Pool({ connectionString: dbUrl }) : null;
  const cleanups: (() => void)[] = [];
  // Codex requires cwd inside a trusted directory; the x-harness project is
  // trusted in ~/.codex/config.toml, so keep worktrees under the repo.
  const workspaceBase = join(process.cwd(), ".ai-workspaces-e2e");

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    rmSync(workspaceBase, { recursive: true, force: true });
    await pool?.query(
      "DELETE FROM events; DELETE FROM workspaces; DELETE FROM runs; DELETE FROM tasks; DELETE FROM repositories;",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("drives Problem -> ... -> Codex -> Verification -> REVIEW with real infra", async () => {
    const fixture: GitFixture = createGitFixture();
    cleanups.push(fixture.cleanup);
    commitFile(fixture.path, "checks.sh", "test -f solution.txt && grep -qx 'avatar upload implemented' solution.txt && echo ok\n");

    const repositories = new PostgresRepositoryStore(pool!);
    const tasks = new PostgresTaskStore(pool!);
    const runs = new PostgresRunStore(pool!);
    const events = new PostgresEventStore(pool!);
    const workspaceManager = new WorkspaceManager({ baseDir: workspaceBase });

    await repositories.createRepository({
      id: "repo-001",
      name: "my-app",
      url: "git@github.com:example/my-app.git",
      localPath: fixture.path,
      verificationCommands: ["sh checks.sh"],
    });
    await tasks.createTask({
      id: "task-001",
      repositoryId: "repo-001",
      title: "Add user avatar",
      description:
        "Create a file named solution.txt in the repository root whose content is exactly " +
        "'avatar upload implemented'. Do not modify any other file.",
      status: "READY",
      acceptance: [
        "solution.txt exists",
        "content is exactly 'avatar upload implemented'",
        "sh checks.sh passes",
      ],
      maxAttempts: 1,
    });

    const worker = new Worker({
      runStore: runs,
      taskStore: tasks,
      repositoryStore: repositories,
      workspaceManager,
      agentEngine: new CodexEngine(), // real `codex exec`
      verifier: new Verifier(),
      eventStore: events,
      workerId: "worker-real-e2e",
      heartbeatMs: 5_000,
      leaseSeconds: 180,
    });
    const loop = new Loop({
      scheduler: new Scheduler({
        taskStore: tasks,
        runStore: runs,
        eventStore: events,
      }),
      worker,
      runStore: runs,
      taskStore: tasks,
      eventStore: events,
      maxConcurrency: 1,
    });

    const report = await loop.tick();
    expect(report.scheduled).toHaveLength(1);
    expect(report.executed).toHaveLength(1);

    const run = (await runs.listRuns({ taskId: "task-001" }))[0];
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.exitCode).toBe(0);
    expect((await tasks.findTask("task-001")).status).toBe("REVIEW");

    const workspaceInfo = run?.result as { workspace?: { path?: string } } | undefined;
    const workspacePath = workspaceInfo?.workspace?.path;
    expect(workspacePath).toBeTruthy();
    expect(existsSync(join(workspacePath!, "solution.txt"))).toBe(true);

    const types = (await events.listEvents({ taskId: "task-001" })).map((event) => event.type);
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

    // 封版验收最后一步：workspace cleanup 必须能回收 worktree。
    const cleanup = await cleanupWorkspacesCommand({
      runs,
      tasks,
      repositories,
      workspaceManager,
    });
    expect(cleanup.removed).toContain(workspacePath);
    expect(existsSync(workspacePath!)).toBe(false);
    expect(await workspaceManager.listWorktrees(fixture.path)).toHaveLength(1);
  }, 600_000);
});
