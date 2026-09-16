import type { ProblemAnalyzer } from "./analyzer.js";
import type {
  AnswerClarificationInput,
  Clarification,
  Problem,
  ProblemAnalysis,
  ProblemSpec,
} from "../domain/problem.js";
import { HarnessError } from "../errors.js";
import type { EventStore } from "../store/eventStore.js";
import type { ProblemStore } from "../store/problemStore.js";
import type { RepositoryStore } from "../store/repositoryStore.js";

export interface ConfirmationLoopOptions {
  problems: ProblemStore;
  analyzer: ProblemAnalyzer;
  repositories?: RepositoryStore;
  events?: EventStore;
}

export interface AnalyzeOutcome {
  problem: Problem;
  analysis?: ProblemAnalysis;
  clarifications: Clarification[];
  needsInput: boolean;
}

/**
 * Confirmation Loop (docs/problem-confirmation-loop.md):
 * Problem -> Analyze -> Clarifications -> Answer -> Analyze -> ... -> CONFIRMED.
 * Stops asking as soon as there is minimum sufficient information.
 */
export class ConfirmationLoop {
  private readonly problems: ProblemStore;
  private readonly analyzer: ProblemAnalyzer;
  private readonly repositories: RepositoryStore | undefined;
  private readonly events: EventStore | undefined;

  constructor(options: ConfirmationLoopOptions) {
    this.problems = options.problems;
    this.analyzer = options.analyzer;
    this.repositories = options.repositories;
    this.events = options.events;
  }

  async analyze(problemId: string): Promise<AnalyzeOutcome> {
    const problem = await this.problems.findProblem(problemId);
    await this.problems.updateProblemStatus(problemId, "ANALYZING");

    let repository;
    if (problem.repositoryId && this.repositories) {
      try {
        repository = await this.repositories.findRepository(problem.repositoryId);
      } catch {
        repository = undefined;
      }
    }

    const history = await this.problems.listClarifications(problemId);
    const result = await this.analyzer.analyze(problem, repository, history);
    const needsInput = result.needsInput || result.clarifications.length > 0;
    const analysis = await this.problems.addAnalysis({
      problemId,
      summary: result.summary,
      uncertainties: result.uncertainties,
      needsInput,
    });
    await this.emit("problem.analysis.updated", problemId, {
      analysisId: analysis.id,
      needsInput,
      uncertainties: result.uncertainties,
    });

    if (!needsInput) {
      const confirmed = await this.problems.updateProblemStatus(problemId, "CONFIRMED");
      await this.emit("problem.confirmed", problemId, { analysisId: analysis.id });
      return { problem: confirmed, analysis, clarifications: [], needsInput: false };
    }

    const clarifications: Clarification[] = [];
    for (const item of result.clarifications) {
      const clarification = await this.problems.createClarification({
        problemId,
        question: item.question,
        type: item.type,
        required: item.required,
        options: item.options,
        reason: item.reason,
      });
      clarifications.push(clarification);
      await this.emit("problem.clarification.created", problemId, {
        clarificationId: clarification.id,
        question: clarification.question,
        type: clarification.type,
      });
    }
    const updated = await this.problems.updateProblemStatus(problemId, "NEEDS_INPUT");
    return { problem: updated, analysis, clarifications, needsInput: true };
  }

  async answer(
    problemId: string,
    clarificationId: string,
    answer: AnswerClarificationInput,
  ): Promise<AnalyzeOutcome> {
    const clarification = await this.problems.findClarification(clarificationId);
    if (clarification.problemId !== problemId) {
      throw new HarnessError(
        `clarification ${clarificationId} does not belong to problem ${problemId}`,
      );
    }
    if (clarification.status !== "OPEN") {
      throw new HarnessError(
        `clarification ${clarificationId} is already ${clarification.status}`,
      );
    }
    const answered = await this.problems.answerClarification(clarificationId, answer);
    await this.emit("problem.clarification.answered", problemId, {
      clarificationId,
      answer: answered.answer,
    });

    const remaining = await this.problems.listClarifications(problemId, {
      status: "OPEN",
    });
    if (remaining.length > 0) {
      const problem = await this.problems.updateProblemStatus(problemId, "ANSWERED");
      return { problem, clarifications: remaining, needsInput: true };
    }
    await this.problems.updateProblemStatus(problemId, "ANSWERED");
    return this.analyze(problemId);
  }

  /** Manual override: accept the current understanding and confirm. */
  async confirm(problemId: string, spec?: ProblemSpec): Promise<Problem> {
    if (spec) {
      await this.problems.setProblemSpec(problemId, spec);
    }
    const problem = await this.problems.updateProblemStatus(problemId, "CONFIRMED");
    await this.emit("problem.confirmed", problemId, { manual: true });
    return problem;
  }

  private async emit(
    type: string,
    problemId: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.events) {
      return;
    }
    try {
      await this.events.record({ type, problemId, payload });
    } catch {
      // History must never break the confirmation loop.
    }
  }
}
