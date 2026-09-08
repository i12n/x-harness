#!/usr/bin/env node

import { Command } from "commander";
import { CodexEngine } from "../agent/codexEngine.js";
import type { Repository } from "../domain/repository.js";
import type { Task, TaskStatus } from "../domain/task.js";
import { TASK_STATUSES } from "../domain/task.js";
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
    await withStores(async ({ tasks, repositories }) => {
      const created = await createTaskCommand(tasks, repositories, options);
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
    await withStores(async ({ tasks, repositories }) => {
      const { task: item, issues } = await validateTaskCommand(tasks, repositories, id);
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
