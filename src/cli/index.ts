#!/usr/bin/env node

import { Command } from "commander";
import { CodexEngine } from "../agent/codexEngine.js";
import type { Repository } from "../domain/repository.js";
import type { Task, TaskStatus } from "../domain/task.js";
import { readTaskReviews, TASK_STATUSES } from "../domain/task.js";
import { openStores, type StoreHandle } from "../store/index.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { Verifier } from "../verification/runner.js";
import {
  createRepositoryCommand,
  listRepositoriesCommand,
  showRepositoryCommand,
} from "./commands/repositoryCommands.js";
import type { RepositoryCreateOptions } from "./commands/repositoryCommands.js";
import {
  createTaskCommand,
  listTasksCommand,
  showTaskCommand,
  validateTaskCommand,
} from "./commands/taskCommands.js";
import type { TaskCreateOptions } from "./commands/taskCommands.js";
import { runTaskCommand } from "./commands/runCommands.js";
import {
  approveTaskCommand,
  rejectTaskCommand,
  reviewRunCommand,
} from "./commands/reviewCommands.js";

const program = new Command();
program
  .name("ai")
  .description("AI Coding Harness v0.1")
  .version("0.1.0");

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return Math.trunc(parsed);
}

async function withStores(
  run: (handle: StoreHandle) => Promise<void>,
): Promise<void> {
  const handle = await openStores();
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// repository commands
// ---------------------------------------------------------------------------

const repository = program.command("repository").description("register and inspect repositories");

repository
  .command("create")
  .description("register a new repository")
  .option("--id <id>", "repository id (default: generated)")
  .requiredOption("--name <name>", "repository name")
  .requiredOption("--url <url>", "clone url (http/https/ssh/git)")
  .option("--default-branch <branch>", "default branch (default: main)")
  .option("--local-path <path>", "local checkout path (default: ~/ai-repos/<name>)")
  .option("--verify <command>", "verification command (repeatable)", collect, [])
  .action(async (options: RepositoryCreateOptions) => {
    await withStores(async ({ repositories }) => {
      const repo = await createRepositoryCommand(repositories, options);
      console.log(`Created ${repo.id} (${repo.name})`);
      printRepository(repo);
    });
  });

repository
  .command("list")
  .description("list registered repositories")
  .action(async () => {
    await withStores(async ({ repositories }) => {
      const repos = await listRepositoriesCommand(repositories);
      if (repos.length === 0) {
        console.log("No repositories registered.");
        return;
      }
      console.log("ID\tNAME\tURL\tBRANCH\tCHECKS");
      for (const repo of repos) {
        console.log(
          `${repo.id}\t${repo.name}\t${repo.url}\t${repo.defaultBranch}\t${repo.verificationCommands.length}`,
        );
      }
    });
  });

repository
  .command("show <id>")
  .description("show one repository")
  .action(async (id: string) => {
    await withStores(async ({ repositories }) => {
      const repo = await showRepositoryCommand(repositories, id);
      printRepository(repo);
    });
  });

// ---------------------------------------------------------------------------
// task commands
// ---------------------------------------------------------------------------

const task = program.command("task").description("create and inspect tasks");

task
  .command("create")
  .description("create a task bound to a repository (status: INBOX)")
  .option("--id <id>", "task id (default: generated)")
  .requiredOption("--repo <id>", "repository id the task belongs to")
  .requiredOption("--title <title>", "task title")
  .option("--description <text>", "task description")
  .option("--accept <criterion>", "acceptance criterion (repeatable)", collect, [])
  .option("--priority <n>", "priority, higher first (default: 50)", parsePositiveInt)
  .option("--max-attempts <n>", "max retry attempts (default: 3)", parsePositiveInt)
  .action(async (options: TaskCreateOptions) => {
    await withStores(async ({ tasks, repositories, events }) => {
      const created = await createTaskCommand(tasks, repositories, options, events);
      console.log(`Created ${created.id} (${created.title})`);
      printTask(created);
    });
  });

task
  .command("list")
  .description("list tasks (optionally filtered by repository/status)")
  .option("--repo <id>", "only tasks of this repository")
  .option("--status <status>", `only tasks with this status (${TASK_STATUSES.join("|")})`)
  .action(async (options: { repo?: string; status?: string }) => {
    await withStores(async ({ tasks }) => {
      const status = normalizeStatusOption(options.status);
      const list = await listTasksCommand(tasks, {
        repositoryId: options.repo,
        status,
      });
      if (list.length === 0) {
        console.log("No tasks found.");
        return;
      }
      console.log("ID\tREPOSITORY\tSTATUS\tPRIORITY\tTITLE");
      for (const item of list) {
        console.log(
          `${item.id}\t${item.repositoryId}\t${item.status}\t${item.priority}\t${item.title}`,
        );
      }
    });
  });

task
  .command("show <id>")
  .description("show one task")
  .action(async (id: string) => {
    await withStores(async ({ tasks }) => {
      const item = await showTaskCommand(tasks, id);
      printTask(item);
    });
  });

task
  .command("validate <id>")
  .description("task intake: move INBOX -> READY or -> BLOCKED")
  .action(async (id: string) => {
    await withStores(async ({ tasks, repositories, events }) => {
      const { task: item, issues } = await validateTaskCommand(tasks, repositories, id, events);
      console.log(`${item.id} -> ${item.status}`);
      if (issues.length === 0) {
        console.log("validation passed");
      } else {
        for (const issue of issues) {
          console.log(`- ${issue}`);
        }
      }
    });
  });

task
  .command("approve <id>")
  .description("approve a REVIEW task -> DONE (human approval)")
  .option("--note <text>", "optional approval note")
  .action(async (id: string, options: { note?: string }) => {
    await withStores(async ({ tasks, events }) => {
      const updated = await approveTaskCommand(tasks, id, options.note, events);
      console.log(`${updated.id} -> ${updated.status}`);
    });
  });

task
  .command("reject <id>")
  .description("reject a REVIEW task -> READY/BLOCKED with feedback")
  .option("--feedback <text>", "feedback for the next attempt")
  .action(async (id: string, options: { feedback?: string }) => {
    await withStores(async ({ tasks, runs, events }) => {
      const updated = await rejectTaskCommand(tasks, runs, id, options.feedback, events);
      console.log(`${updated.id} -> ${updated.status}`);
    });
  });

program
  .command("review <run-id>")
  .description("run a reviewer agent over a SUCCEEDED run's workspace diff")
  .action(async (runId: string) => {
    await withStores(async ({ tasks, runs, repositories, events }) => {
      const outcome = await reviewRunCommand({
        tasks,
        runs,
        repositories,
        workspaceManager: new WorkspaceManager(),
        engine: new CodexEngine({ sandbox: "read-only" }),
        runId,
        events,
      });
      console.log(`reviewed run ${runId} -> task ${outcome.task.id} (${outcome.task.status})`);
      console.log("--- review ---");
      console.log(outcome.review.text);
      console.log("--------------");
      console.log(`reviews recorded: ${readTaskReviews(outcome.task).length}`);
    });
  });

const event = program.command("event").description("inspect event history");
event
  .command("list")
  .description("list recorded events (optionally filtered)")
  .option("--task <id>", "only events for this task")
  .option("--run <id>", "only events for this run")
  .option("--type <type>", "only events of this type")
  .option("--limit <n>", "number of most recent events to show", parsePositiveInt)
  .action(async (options: { task?: string; run?: string; type?: string; limit?: number }) => {
    await withStores(async ({ events }) => {
      const list = await events.listEvents({
        taskId: options.task,
        runId: options.run,
        type: options.type,
        limit: options.limit,
      });
      if (list.length === 0) {
        console.log("No events found.");
        return;
      }
      console.log("ID\tTYPE\tTASK\tRUN\tCREATED");
      for (const item of list) {
        console.log(`${item.id}\t${item.type}\t${item.taskId ?? "-"}\t${item.runId ?? "-"}\t${item.createdAt}`);
      }
    });
  });

program
  .command("run <task-id>")
  .description("manually run one task: workspace -> context -> codex -> result")
  .action(async (taskId: string) => {
    await withStores(async ({ tasks, repositories }) => {
      const outcome = await runTaskCommand({
        tasks,
        repositories,
        workspaceManager: new WorkspaceManager(),
        engine: new CodexEngine(),
        verifier: new Verifier(),
        taskId,
      });
      console.log(`run id: ${outcome.runId}`);
      console.log(`task: ${outcome.task.id} (${outcome.task.title})`);
      console.log(`repository: ${outcome.repository.id} (${outcome.repository.name})`);
      console.log(`workspace: ${outcome.workspace.path} [${outcome.workspace.branch}]`);
      console.log(`agent exit code: ${outcome.result.exitCode ?? "null"}`);
      const tail = outcome.result.stdout.trim().split("\n").slice(-10).join("\n");
      if (tail) {
        console.log("agent output:");
        console.log(tail);
      }
      if (outcome.result.stderr.trim()) {
        console.log("agent stderr:");
        console.log(outcome.result.stderr.trim());
      }
      const passedChecks = outcome.verification.checks.filter(
        (check) => check.status === "passed",
      ).length;
      console.log(
        `verification: ${outcome.verification.passed ? "PASSED" : "FAILED"} ` +
          `(${passedChecks}/${outcome.verification.checks.length} checks passed)`,
      );
      for (const check of outcome.verification.checks) {
        console.log(`- ${check.name} ${check.status} (${check.command || "no command"})`);
      }
      console.log(
        outcome.succeeded
          ? "run SUCCEEDED: verification passed"
          : "run FAILED: verification failed (agent execution is not task completion)",
      );
    });
  });

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function printRepository(repo: Repository): void {
  console.log(`id: ${repo.id}`);
  console.log(`name: ${repo.name}`);
  console.log(`url: ${repo.url}`);
  console.log(`default_branch: ${repo.defaultBranch}`);
  console.log(`local_path: ${repo.localPath}`);
  console.log("verification:");
  if (repo.verificationCommands.length === 0) {
    console.log("  (none)");
  } else {
    for (const command of repo.verificationCommands) {
      console.log(`  - ${command}`);
    }
  }
}

function printTask(item: Task): void {
  console.log(`id: ${item.id}`);
  console.log(`repository_id: ${item.repositoryId}`);
  console.log(`title: ${item.title}`);
  console.log(`status: ${item.status}`);
  console.log(`priority: ${item.priority}`);
  console.log(`max_attempts: ${item.maxAttempts}`);
  console.log(`description: ${item.description || "(none)"}`);
  console.log("acceptance:");
  if (item.acceptance.length === 0) {
    console.log("  (none)");
  } else {
    for (const criterion of item.acceptance) {
      console.log(`  - ${criterion}`);
    }
  }
  const reviews = readTaskReviews(item);
  console.log(`reviews: ${reviews.length}`);
  for (const review of reviews) {
    console.log(`  - [${review.at}] ${review.runId}: ${review.text.split("\n")[0] ?? ""}`);
  }
}

function normalizeStatusOption(value: string | undefined): TaskStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const upper = value.toUpperCase();
  if (!(TASK_STATUSES as readonly string[]).includes(upper)) {
    throw new Error(`invalid status '${value}' (use one of: ${TASK_STATUSES.join("|")})`);
  }
  return upper as TaskStatus;
}

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `error: ${error.message}`;
  }
  return `error: ${String(error)}`;
}
