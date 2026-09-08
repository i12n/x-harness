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
import { Loop } from "../src/loop/loop.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";
import { PostgresRepositoryStore } from "../src/store/postgresRepositoryStore.js";
import { PostgresRunStore } from "../src/store/postgresRunStore.js";
import { PostgresTaskStore } from "../src/store/postgresTaskStore.js";
import { PostgresEventStore } from "../src/store/postgresEventStore.js";
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

describePostgres("PostgreSQL integration", () => {
  const pool = enabled ? new Pool({ connectionString: dbUrl }) : null;
  const cleanups: (() => void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    await pool?.query("DELETE FROM events; DELETE FROM workspaces; DELETE FROM runs; DELETE FROM tasks; DELETE FROM repositories;");
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
});
