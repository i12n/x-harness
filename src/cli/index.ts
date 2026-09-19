#!/usr/bin/env node

import { Command } from "commander";
import { CodexEngine } from "../agent/codexEngine.js";
import { Loop } from "../loop/loop.js";
import { ProblemAnalyzer } from "../problem/analyzer.js";
import { ConfirmationLoop } from "../problem/confirmationLoop.js";
import type { AnalyzeOutcome } from "../problem/confirmationLoop.js";
import { Scheduler } from "../scheduler/scheduler.js";
import type { Problem, ProblemStatus } from "../domain/problem.js";
import { PROBLEM_STATUSES } from "../domain/problem.js";
import { buildExecutionProfile } from "../domain/executionProfile.js";
import type { ExecutionProfile } from "../domain/executionProfile.js";
import type { Repository } from "../domain/repository.js";
import type { ProblemDetail } from "./commands/problemCommands.js";
import {
  analyzeProblemCommand,
  answerProblemCommand,
  confirmProblemCommand,
  convertProblemToTaskCommand,
  createProblemCommand,
  listProblemsCommand,
  showProblemCommand,
} from "./commands/problemCommands.js";
import type { Task, TaskStatus } from "../domain/task.js";
import { readTaskReviews, TASK_STATUSES } from "../domain/task.js";
import { openStores, type StoreHandle } from "../store/index.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { Verifier } from "../verification/runner.js";
import { Worker } from "../worker/worker.js";
import {
  ExecutionManager,
  LocalExecutionDriver,
} from "../execution/manager.js";
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
import {
  approveTaskCommand,
  rejectTaskCommand,
  reviewRunCommand,
} from "./commands/reviewCommands.js";
import { cleanupWorkspacesCommand } from "./commands/workspaceCommands.js";
import {
  formatRunDetails,
  formatTaskDependencies,
  formatTaskTargets,
} from "./output.js";
import { formatSpecificationPlan } from "./specificationOutput.js";
import { CliChannel } from "../channel/cli/adapter.js";
import {
  COMMAND_VERSION,
  CommandDispatcher,
  InMemoryIdempotencyStore,
  isRole,
  type CommandType,
} from "../command/index.js";
import { createSpecificationCommandHandlers } from "../command/handlers/specification.js";
import type { SpecificationPlanView } from "./specificationOutput.js";
import { PlanningService } from "../specification/application/planning.js";
import { DeterministicTaskPlanner } from "../specification/application/planner.js";
import { TaskDependencyService } from "../task/application/dependencyService.js";
import { makeId } from "../util/id.js";

const cliChannel = new CliChannel();

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

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid positive number: ${value}`);
  }
  return parsed;
}

function parseBaseRef(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid --base-ref '${value}' (expected <repositoryId>=<ref>)`);
  }
  const repositoryId = value.slice(0, separator).trim();
  const ref = value.slice(separator + 1).trim();
  if (!repositoryId || !ref) {
    throw new Error(`invalid --base-ref '${value}' (expected <repositoryId>=<ref>)`);
  }
  return { ...previous, [repositoryId]: ref };
}

async function loadRepositoryNames(
  repositories: { findRepository(id: string): Promise<{ id: string; name: string }> },
  ids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of [...new Set(ids)]) {
    try {
      const repository = await repositories.findRepository(id);
      names.set(repository.id, repository.name);
    } catch {
      names.set(id, id);
    }
  }
  return names;
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
  .option("--exec-image <image>", "container image for the execution profile")
  .option("--exec-profile <name>", "execution profile name (default: default)")
  .option("--network <mode>", "container network mode: none | restricted")
  .option("--allow <host>", "allowed egress host in restricted mode (repeatable)", collect, [])
  .option("--secret <name>", "secret NAME injected per run (repeatable)", collect, [])
  .option("--cpus <n>", "container CPU limit (e.g. 2 or 0.5)", parsePositiveNumber)
  .option("--memory-mb <n>", "container memory limit in MB", parsePositiveInt)
  .option("--pids-limit <n>", "container pids limit", parsePositiveInt)
  .action(async (options: RepositoryCreateOptions) => {
    await withStores(async ({ repositories }) => {
      const executionProfile = buildExecutionProfileFromCliOptions(options);
      const repo = await createRepositoryCommand(repositories, {
        ...options,
        executionProfile,
      });
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
  .description("create a task (first --repo is primary; repeat for multi-repo)")
  .option("--id <id>", "task id (default: generated)")
  .option("--repo <id>", "repository id (repeatable; first is primary)", collect, [])
  .option("--base-ref <repoId=ref>", "base ref per repository (repeatable)", parseBaseRef, {})
  .requiredOption("--title <title>", "task title")
  .option("--description <text>", "task description")
  .option("--accept <criterion>", "acceptance criterion (repeatable)", collect, [])
  .option("--priority <n>", "priority, higher first (default: 50)", parsePositiveInt)
  .option("--max-attempts <n>", "max retry attempts (default: 3)", parsePositiveInt)
  .action(async (options: TaskCreateOptions) => {
    await withStores(async ({ tasks, repositories, events }) => {
      const rawRepo = options.repo as unknown;
      const repos = Array.isArray(rawRepo)
        ? (rawRepo as string[])
        : rawRepo
          ? [String(rawRepo)]
          : [];
      const baseRefs =
        (options as unknown as { baseRef?: Record<string, string> }).baseRef ?? {};
      const created = await createTaskCommand(
        tasks,
        repositories,
        { ...options, repo: undefined, repos, baseRefs },
        events,
      );
      console.log(`Created ${created.id} (${created.title})`);
      printTask(
        created,
        await loadRepositoryNames(
          repositories,
          created.targets.map((target) => target.repositoryId),
        ),
      );
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
    await withStores(async (handle) => {
      const { tasks, repositories, runs } = handle;
      const item = await showTaskCommand(tasks, id);
      printTask(
        item,
        await loadRepositoryNames(
          repositories,
          item.targets.map((target) => target.repositoryId),
        ),
      );
      // TASK-1204: make "READY but gated by dependencies" visible.
      const dependencyService = new TaskDependencyService({
        tasks,
        dependencies: handle.taskDependencies,
        events: handle.events,
      });
      const dependency = await dependencyService.describe(id);
      for (const line of formatTaskDependencies({
        runnable: await dependencyService.isRunnable(id),
        prerequisites: dependency.prerequisites.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
        })),
      })) {
        console.log(line);
      }
      const taskRuns = await runs.listRuns({ taskId: id });
      const latest = taskRuns[taskRuns.length - 1];
      if (latest) {
        console.log("");
        for (const line of formatRunDetails(latest)) {
          console.log(line);
        }
      }
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

const problemGroup = program.command("problem").description("problem confirmation loop");

problemGroup
  .command("create")
  .description("record a raw problem (status: INBOX)")
  .option("--id <id>", "problem id (default: generated)")
  .requiredOption("--title <title>", "short problem title")
  .requiredOption("--statement <text>", "raw problem statement")
  .option("--repo <id>", "optional target repository id")
  .action(async (options: { id?: string; title: string; statement: string; repo?: string }) => {
    await withStores(async ({ problems, events }) => {
      const problem = await createProblemCommand(problems, options, events);
      console.log(`Created ${problem.id} (${problem.title})`);
      printProblemDetail({ problem, analyses: [], clarifications: [] });
    });
  });

problemGroup
  .command("list")
  .description("list problems")
  .option("--status <status>", "only problems with this status")
  .option("--repo <id>", "only problems for this repository")
  .action(async (options: { status?: string; repo?: string }) => {
    await withStores(async ({ problems }) => {
      const status = options.status ? normalizeProblemStatus(options.status) : undefined;
      const list = await listProblemsCommand(problems, {
        status,
        repositoryId: options.repo,
      });
      if (list.length === 0) {
        console.log("No problems found.");
        return;
      }
      console.log("ID\tSTATUS\tREPO\tTITLE");
      for (const item of list) {
        console.log(`${item.id}\t${item.status}\t${item.repositoryId ?? "-"}\t${item.title}`);
      }
    });
  });

problemGroup
  .command("show <id>")
  .description("show one problem with analyses and clarifications")
  .action(async (id: string) => {
    await withStores(async ({ problems }) => {
      printProblemDetail(await showProblemCommand(problems, id));
    });
  });

problemGroup
  .command("analyze <id>")
  .description("run one analysis round; creates clarifications when needed")
  .action(async (id: string) => {
    await withStores(async (handle) => {
      const outcome = await analyzeProblemCommand(confirmationLoop(handle), id);
      printAnalyzeOutcome(outcome);
    });
  });

problemGroup
  .command("answer <problem-id> <clarification-id>")
  .description("answer a clarification and re-run analysis")
  .option("--option <id>", "choose one of the offered options")
  .option("--text <text>", "free-text answer (the \"other\" case)")
  .action(async (
    problemId: string,
    clarificationId: string,
    options: { option?: string; text?: string },
  ) => {
    await withStores(async (handle) => {
      const outcome = await answerProblemCommand(
        confirmationLoop(handle),
        problemId,
        clarificationId,
        options,
      );
      printAnalyzeOutcome(outcome);
    });
  });

problemGroup
  .command("confirm <id>")
  .description("manually confirm a problem (optionally recording the spec)")
  .option("--problem <text>", "confirmed problem statement")
  .option("--expected <text>", "expected behaviour")
  .option("--scope <text>", "scope")
  .option("--investigation <text>", "investigation notes")
  .action(async (
    id: string,
    options: { problem?: string; expected?: string; scope?: string; investigation?: string },
  ) => {
    await withStores(async (handle) => {
      const confirmed = await confirmProblemCommand(confirmationLoop(handle), id, options);
      console.log(`${confirmed.id} -> ${confirmed.status}`);
      if (confirmed.confirmedSpec) {
        printProblemSpec(confirmed);
      }
    });
  });

problemGroup
  .command("task <id>")
  .description("convert a CONFIRMED problem into an executable Task")
  .requiredOption("--repo <id>", "repository the task targets")
  .action(async (id: string, options: { repo: string }) => {
    await withStores(async ({ problems, tasks, repositories, events }) => {
      const outcome = await convertProblemToTaskCommand({
        problems,
        tasks,
        repositories,
        events,
        problemId: id,
        repositoryId: options.repo,
      });
      console.log(`task created: ${outcome.task.id} (${outcome.task.title})`);
      console.log(`problem ${outcome.problem.id} -> ${outcome.problem.status}`);
    });
  });

const specGroup = program
  .command("spec")
  .description("specification & task planning (Phase 12)");

specGroup
  .command("show <id>")
  .description("show a specification, its targets and its plan")
  .option("--role <role>", "authorization role (default: developer)")
  .action(async (id: string, options: { role?: string }) => {
    await withStores(async (handle) => {
      const view = await dispatchSpecificationCommand(handle, "spec.show", id, options.role);
      await cliChannel.send({
        conversationId: id,
        text: formatSpecificationPlan(view).join("\n"),
      });
    });
  });

specGroup
  .command("plan <id>")
  .description("plan a READY specification into Tasks (idempotent)")
  .option("--role <role>", "authorization role (default: developer)")
  .action(async (id: string, options: { role?: string }) => {
    await withStores(async (handle) => {
      const view = await dispatchSpecificationCommand(handle, "spec.plan", id, options.role);
      await cliChannel.send({
        conversationId: id,
        text: formatSpecificationPlan(view).join("\n"),
      });
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
  .option("--problem <id>", "only events for this problem")
  .option("--type <type>", "only events of this type")
  .option("--limit <n>", "number of most recent events to show", parsePositiveInt)
  .action(async (options: { task?: string; run?: string; problem?: string; type?: string; limit?: number }) => {
    await withStores(async ({ events }) => {
      const list = await events.listEvents({
        taskId: options.task,
        runId: options.run,
        problemId: options.problem,
        type: options.type,
        limit: options.limit,
      });
      if (list.length === 0) {
        console.log("No events found.");
        return;
      }
      console.log("ID\tTYPE\tTASK\tRUN\tPROBLEM\tCREATED");
      for (const item of list) {
        console.log(
          `${item.id}\t${item.type}\t${item.taskId ?? "-"}\t${item.runId ?? "-"}\t${item.problemId ?? "-"}\t${item.createdAt}`,
        );
      }
    });
  });

program
  .command("run <task-id>")
  .description("run one task once (workspaces -> mounts -> codex -> verification)")
  .action(async (taskId: string) => {
    await withStores(async (handle) => {
      const task = await handle.tasks.findTask(taskId);
      const existing = await handle.runs.listRuns({ taskId: task.id });
      const run = await handle.runs.createRun({
        taskId: task.id,
        attempt: existing.length + 1,
        agent: "codex",
        engine: "codex",
      });
      const workspaceManager = new WorkspaceManager();
      const executionManager = new ExecutionManager({
        driver: new LocalExecutionDriver(),
        executions: handle.executions,
        events: handle.events,
      });
      const worker = new Worker({
        runStore: handle.runs,
        taskStore: handle.tasks,
        repositoryStore: handle.repositories,
        workspaceManager,
        agentEngine: new CodexEngine(),
        verifier: new Verifier(),
        executionManager,
        eventStore: handle.events,
        workerId: "cli-run",
      });

      try {
        const outcome = await worker.executeRun(run.id);
        await cliChannel.send({
          conversationId: taskId,
          text: [
            `run id: ${outcome.run.id}`,
            `task: ${outcome.task.id} (${outcome.task.title})`,
            `agent exit code: ${outcome.agentResult.exitCode ?? "null"}`,
          ].join("\n"),
        });
        await cliChannel.send({
          conversationId: taskId,
          text: formatRunDetails(outcome.run).join("\n"),
        });
      } catch (error) {
        const stored = await handle.runs.findRun(run.id);
        await cliChannel.send({
          conversationId: taskId,
          text: formatRunDetails(stored).join("\n"),
        });
        throw error;
      }
    });
  });

const workspace = program.command("workspace").description("manage run workspaces");
workspace
  .command("cleanup")
  .description("remove worktrees of terminal runs (SUCCEEDED/FAILED/LOST/...)")
  .action(async () => {
    await withStores(async ({ runs, tasks, repositories }) => {
      const report = await cleanupWorkspacesCommand({
        runs,
        tasks,
        repositories,
        workspaceManager: new WorkspaceManager(),
      });
      console.log(`removed ${report.removed.length} workspace(s)`);
      for (const path of report.removed) {
        console.log(`- removed ${path}`);
      }
      if (report.skipped.length > 0) {
        console.log(`skipped ${report.skipped.length} run(s):`);
        for (const entry of report.skipped) {
          console.log(`- ${entry.runId}: ${entry.reason}`);
        }
      }
    });
  });

program
  .command("loop")
  .description("run the reconcile loop (default: continuously; use --once)")
  .option("--once", "run a single tick and exit")
  .option("--interval-ms <n>", "tick interval in ms (default: 1000)", parsePositiveInt)
  .action(async (options: { once?: boolean; intervalMs?: number }) => {
    const handle = await openStores();
    const workspaceManager = new WorkspaceManager();
    const engine = new CodexEngine();
    const executionManager = new ExecutionManager({
      driver: new LocalExecutionDriver(),
      executions: handle.executions,
      events: handle.events,
    });
    const worker = new Worker({
      runStore: handle.runs,
      taskStore: handle.tasks,
      repositoryStore: handle.repositories,
      workspaceManager,
      agentEngine: engine,
      verifier: new Verifier(),
      executionManager,
      eventStore: handle.events,
    });
    const loop = new Loop({
      scheduler: new Scheduler({
        taskStore: handle.tasks,
        runStore: handle.runs,
        eventStore: handle.events,
        // TASK-1204: READY tasks also have to be runnable (deps DONE).
        runnableTasks: new TaskDependencyService({
          tasks: handle.tasks,
          dependencies: handle.taskDependencies,
          events: handle.events,
        }),
      }),
      worker,
      runStore: handle.runs,
      taskStore: handle.tasks,
      eventStore: handle.events,
      executions: handle.executions,
      executionManager,
      repositories: handle.repositories,
      workspaceManager,
    });

    if (options.once) {
      try {
        const report = await loop.tick();
        console.log(
          `recovered=${report.recovered.length} scheduled=${report.scheduled.length} executed=${report.executed.length}`,
        );
      } finally {
        await handle.close();
      }
      return;
    }

    console.log("loop started (Ctrl-C to stop)");
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) {
        return;
      }
      stopping = true;
      loop.stop();
      await handle.close();
      console.log("loop stopped");
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    await loop.start(options.intervalMs ?? 1_000);
    if (!stopping) {
      await handle.close();
    }
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
  const profile = repo.executionProfile;
  const allowedHosts =
    profile.network.allow.length > 0 ? `(${profile.network.allow.join(",")})` : "";
  console.log(
    `execution_profile: ${profile.name} image=${profile.image} ` +
      `network=${profile.network.mode}${allowedHosts} ` +
      `cpus=${profile.resources.cpus} memory=${profile.resources.memoryMb}MB ` +
      `pids=${profile.resources.pidsLimit} ` +
      `secrets=${profile.secrets.length > 0 ? profile.secrets.join(",") : "(none)"}`,
  );
  console.log("verification:");
  if (repo.verificationCommands.length === 0) {
    console.log("  (none)");
  } else {
    for (const command of repo.verificationCommands) {
      console.log(`  - ${command}`);
    }
  }
}

function printTask(item: Task, repositoryNames: Map<string, string> = new Map()): void {
  console.log(`id: ${item.id}`);
  console.log(`repository_id: ${item.repositoryId}`);
  console.log(`title: ${item.title}`);
  console.log(`status: ${item.status}`);
  console.log(`priority: ${item.priority}`);
  console.log(`max_attempts: ${item.maxAttempts}`);
  console.log(`description: ${item.description || "(none)"}`);
  for (const line of formatTaskTargets(item, repositoryNames)) {
    console.log(line);
  }
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

function confirmationLoop(handle: StoreHandle): ConfirmationLoop {
  return new ConfirmationLoop({
    problems: handle.problems,
    repositories: handle.repositories,
    events: handle.events,
    analyzer: new ProblemAnalyzer(
      new CodexEngine({ sandbox: process.env.AI_ANALYZER_SANDBOX ?? "read-only" }),
    ),
  });
}

/**
 * Phase 12 / TASK-1202: specification commands go through the command layer
 * (validation → authorization → idempotency → handler). The CLI never calls
 * PlanningService directly, so chat and CLI share one entry point.
 */
function dispatchSpecificationCommand(
  handle: StoreHandle,
  type: Extract<CommandType, "spec.show" | "spec.plan">,
  specificationId: string,
  roleOption?: string,
): Promise<SpecificationPlanView> {
  const role = roleOption?.trim() || "developer";
  if (!isRole(role)) {
    throw new Error(`invalid role '${role}' (use guest|developer|reviewer|admin)`);
  }
  const planning = new PlanningService({
    specifications: handle.specifications,
    plans: handle.specificationPlans,
    tasks: handle.tasks,
    planner: new DeterministicTaskPlanner(),
    events: handle.events,
  });
  const dispatcher = new CommandDispatcher({
    handlers: createSpecificationCommandHandlers({ planning }),
    idempotency: new InMemoryIdempotencyStore(),
  });
  return dispatcher
    .dispatch(
      {
        id: makeId("cmd"),
        type,
        version: COMMAND_VERSION,
        actor: { channel: "cli", userId: "cli-user" },
        payload: { specificationId },
        idempotencyKey: `cli:${makeId("msg")}:${type}`,
        createdAt: new Date().toISOString(),
      },
      { channel: "cli", userId: "cli-user", roles: [role] },
    )
    .then((result) => {
      if (result.status !== "succeeded") {
        const code = result.error?.code ?? "unknown";
        throw new Error(`${type} ${result.status}: ${code} ${result.error?.message ?? ""}`.trim());
      }
      return result.data as SpecificationPlanView;
    });
}

type RepositoryCreateCliOptions = RepositoryCreateOptions & {
  execImage?: string;
  execProfile?: string;
  network?: string;
  allow?: string[];
  secret?: string[];
  cpus?: number;
  memoryMb?: number;
  pidsLimit?: number;
};

/**
 * TASK-902: repository -> execution profile binding. Only build a custom
 * profile when the user actually passed execution flags; otherwise the domain
 * default (most restrictive) applies.
 */
function buildExecutionProfileFromCliOptions(
  options: RepositoryCreateCliOptions,
): ExecutionProfile | undefined {
  const hasOptions = Boolean(
    options.execImage ||
      options.execProfile ||
      options.network ||
      options.cpus ||
      options.memoryMb ||
      options.pidsLimit ||
      (options.allow?.length ?? 0) > 0 ||
      (options.secret?.length ?? 0) > 0,
  );
  if (!hasOptions) {
    return undefined;
  }
  return buildExecutionProfile({
    name: options.execProfile?.trim() || "default",
    image: options.execImage?.trim() || "harness/execution:base",
    network: {
      mode:
        (options.network as "none" | "restricted" | undefined) ??
        ((options.allow?.length ?? 0) > 0 ? "restricted" : "none"),
      allow: options.allow ?? [],
    },
    resources: {
      cpus: options.cpus,
      memoryMb: options.memoryMb,
      pidsLimit: options.pidsLimit,
    },
    secrets: options.secret ?? [],
  });
}

function normalizeProblemStatus(value: string): ProblemStatus {
  const upper = value.toUpperCase();
  if (!(PROBLEM_STATUSES as readonly string[]).includes(upper)) {
    throw new Error(
      `invalid problem status '${value}' (use one of: ${PROBLEM_STATUSES.join("|")})`,
    );
  }
  return upper as ProblemStatus;
}

function printProblemSpec(problem: Problem): void {
  const spec = problem.confirmedSpec;
  if (!spec) {
    return;
  }
  console.log("confirmed_spec:");
  console.log(`  problem: ${spec.problem}`);
  console.log(`  expected: ${spec.expected}`);
  if (spec.scope) {
    console.log(`  scope: ${spec.scope}`);
  }
  if (spec.investigation) {
    console.log(`  investigation: ${spec.investigation}`);
  }
}

function printProblemDetail(detail: ProblemDetail): void {
  const { problem, analyses, clarifications } = detail;
  console.log(`id: ${problem.id}`);
  console.log(`title: ${problem.title}`);
  console.log(`status: ${problem.status}`);
  console.log(`repository_id: ${problem.repositoryId ?? "-"}`);
  console.log(`statement: ${problem.statement}`);
  printProblemSpec(problem);
  console.log(`analyses: ${analyses.length}`);
  for (const analysis of analyses) {
    console.log(
      `  - [${analysis.createdAt}] needsInput=${analysis.needsInput} ${analysis.summary}`,
    );
  }
  console.log(`clarifications: ${clarifications.length}`);
  for (const clarification of clarifications) {
    console.log(
      `  - ${clarification.id} [${clarification.status}] (${clarification.type}) ${clarification.question}`,
    );
    for (const option of clarification.options) {
      console.log(`      ○ ${option.id}: ${option.label}`);
    }
    if (clarification.answer) {
      console.log(
        `    answer: ${clarification.answer.optionId ?? clarification.answer.text ?? "-"}`,
      );
    }
  }
}

function printAnalyzeOutcome(outcome: AnalyzeOutcome): void {
  console.log(`${outcome.problem.id} -> ${outcome.problem.status}`);
  if (outcome.analysis) {
    console.log(`analysis: ${outcome.analysis.summary}`);
  }
  if (!outcome.needsInput) {
    console.log("confirmed: no open clarifications");
    return;
  }
  for (const clarification of outcome.clarifications) {
    console.log(`- ${clarification.id} (${clarification.type}) ${clarification.question}`);
    for (const option of clarification.options) {
      console.log(`    ○ ${option.id}: ${option.label}`);
    }
    if (clarification.reason) {
      console.log(`  why: ${clarification.reason}`);
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
