import type {
  Clarification,
  CreateProblemInput,
  Problem,
  ProblemAnalysis,
  ProblemSpec,
} from "../../domain/problem.js";
import type { Task } from "../../domain/task.js";
import { HarnessError } from "../../errors.js";
import type { ConfirmationLoop } from "../../problem/confirmationLoop.js";
import type { EventStore } from "../../store/eventStore.js";
import type { ProblemListFilter, ProblemStore } from "../../store/problemStore.js";
import type { RepositoryStore } from "../../store/repositoryStore.js";
import type { TaskStore } from "../../store/taskStore.js";

export interface ProblemCreateOptions {
  id?: string;
  title: string;
  statement: string;
  repo?: string;
}

export async function createProblemCommand(
  problems: ProblemStore,
  options: ProblemCreateOptions,
  events?: EventStore,
): Promise<Problem> {
  const input: CreateProblemInput = {
    id: options.id,
    title: options.title,
    statement: options.statement,
    repositoryId: options.repo,
  };
  const problem = await problems.createProblem(input);
  await record(events, "problem.created", problem.id, {
    title: problem.title,
    repositoryId: problem.repositoryId,
  });
  return problem;
}

export async function listProblemsCommand(
  problems: ProblemStore,
  filter: ProblemListFilter,
): Promise<Problem[]> {
  return problems.listProblems(filter);
}

export interface ProblemDetail {
  problem: Problem;
  analyses: ProblemAnalysis[];
  clarifications: Clarification[];
}

export async function analyzeProblemCommand(
  loop: ConfirmationLoop,
  problemId: string,
) {
  return loop.analyze(problemId);
}

export async function answerProblemCommand(
  loop: ConfirmationLoop,
  problemId: string,
  clarificationId: string,
  answer: { option?: string; text?: string },
) {
  return loop.answer(problemId, clarificationId, {
    optionId: answer.option,
    text: answer.text,
  });
}

export async function showProblemCommand(
  problems: ProblemStore,
  id: string,
): Promise<ProblemDetail> {
  const problem = await problems.findProblem(id);
  return {
    problem,
    analyses: await problems.listAnalyses(id),
    clarifications: await problems.listClarifications(id),
  };
}

export interface ConfirmProblemOptions {
  problem?: string;
  expected?: string;
  scope?: string;
  investigation?: string;
}

export async function confirmProblemCommand(
  loop: ConfirmationLoop,
  problemId: string,
  options: ConfirmProblemOptions = {},
): Promise<Problem> {
  let spec: ProblemSpec | undefined;
  if (options.problem || options.expected) {
    if (!options.problem?.trim() || !options.expected?.trim()) {
      throw new HarnessError("confirming with a spec requires both --problem and --expected");
    }
    spec = {
      problem: options.problem.trim(),
      expected: options.expected.trim(),
      scope: options.scope?.trim() || undefined,
      investigation: options.investigation?.trim() || undefined,
    };
  }
  return loop.confirm(problemId, spec);
}

export interface ConvertProblemParams {
  problems: ProblemStore;
  tasks: TaskStore;
  repositories: RepositoryStore;
  events?: EventStore;
  problemId: string;
  repositoryId: string;
}

export interface ConvertProblemOutcome {
  problem: Problem;
  task: Task;
}

/**
 * Specification bridge: CONFIRMED problem -> executable Task, so the existing
 * Scheduler/Worker/Codex chain can pick it up.
 */
export async function convertProblemToTaskCommand(
  params: ConvertProblemParams,
): Promise<ConvertProblemOutcome> {
  const problem = await params.problems.findProblem(params.problemId);
  if (problem.status !== "CONFIRMED" && problem.status !== "SPECIFIED") {
    throw new HarnessError(
      `problem ${problem.id} must be CONFIRMED before conversion (status is ${problem.status})`,
    );
  }
  await params.repositories.findRepository(params.repositoryId);

  const spec = problem.confirmedSpec;
  const description = [
    `Problem: ${problem.statement}`,
    spec ? `Confirmed problem: ${spec.problem}` : "",
    spec ? `Expected: ${spec.expected}` : "",
    spec?.scope ? `Scope: ${spec.scope}` : "",
    spec?.investigation ? `Investigation notes: ${spec.investigation}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const acceptance = spec?.expected ? [spec.expected] : [];

  const task = await params.tasks.createTask({
    repositoryId: params.repositoryId,
    title: problem.title,
    description,
    acceptance,
    constraints: { problemId: problem.id },
  });
  await params.problems.updateProblemStatus(problem.id, "SPECIFIED");
  await record(params.events, "problem.specified", problem.id, { taskId: task.id });
  const ready = await params.problems.updateProblemStatus(problem.id, "READY");
  await record(params.events, "problem.ready", problem.id, { taskId: task.id });
  return { problem: ready, task };
}

async function record(
  events: EventStore | undefined,
  type: string,
  problemId: string,
  payload: unknown,
): Promise<void> {
  if (!events) {
    return;
  }
  try {
    await events.record({ type, problemId, payload });
  } catch {
    // History must never break problem commands.
  }
}
