import {
  buildClarification,
  buildProblem,
  buildProblemAnalysis,
} from "../domain/problem.js";
import type {
  AnswerClarificationInput,
  Clarification,
  CreateClarificationInput,
  CreateProblemAnalysisInput,
  CreateProblemInput,
  Problem,
  ProblemAnalysis,
  ProblemSpec,
  ProblemStatus,
} from "../domain/problem.js";
import {
  ClarificationNotFoundError,
  DuplicateProblemError,
  ProblemNotFoundError,
  ValidationError,
} from "../errors.js";
import type {
  ClarificationListFilter,
  ProblemListFilter,
  ProblemStore,
} from "./problemStore.js";

/** Non-persistent problem store, used by tests and memory-mode demos. */
export class InMemoryProblemStore implements ProblemStore {
  private readonly problems = new Map<string, Problem>();
  private readonly analyses = new Map<string, ProblemAnalysis[]>();
  private readonly clarifications = new Map<string, Clarification>();

  async createProblem(input: CreateProblemInput): Promise<Problem> {
    const problem = buildProblem(input);
    if (this.problems.has(problem.id)) {
      throw new DuplicateProblemError(problem.id);
    }
    this.problems.set(problem.id, problem);
    return problem;
  }

  async listProblems(filter: ProblemListFilter = {}): Promise<Problem[]> {
    return [...this.problems.values()]
      .filter(
        (problem) =>
          (filter.status === undefined || problem.status === filter.status) &&
          (filter.repositoryId === undefined ||
            problem.repositoryId === filter.repositoryId),
      )
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }

  async findProblem(id: string): Promise<Problem> {
    const problem = this.problems.get(id);
    if (!problem) {
      throw new ProblemNotFoundError(id);
    }
    return problem;
  }

  async updateProblemStatus(id: string, status: ProblemStatus): Promise<Problem> {
    const problem = await this.findProblem(id);
    const updated: Problem = {
      ...problem,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.problems.set(id, updated);
    return updated;
  }

  async setProblemSpec(id: string, spec: ProblemSpec): Promise<Problem> {
    const problem = await this.findProblem(id);
    const updated: Problem = {
      ...problem,
      confirmedSpec: spec,
      updatedAt: new Date().toISOString(),
    };
    this.problems.set(id, updated);
    return updated;
  }

  async addAnalysis(input: CreateProblemAnalysisInput): Promise<ProblemAnalysis> {
    const analysis = buildProblemAnalysis(input);
    const list = this.analyses.get(input.problemId) ?? [];
    list.push(analysis);
    this.analyses.set(input.problemId, list);
    return analysis;
  }

  async listAnalyses(problemId: string): Promise<ProblemAnalysis[]> {
    return [...(this.analyses.get(problemId) ?? [])];
  }

  async createClarification(input: CreateClarificationInput): Promise<Clarification> {
    const clarification = buildClarification(input);
    if (this.clarifications.has(clarification.id)) {
      throw new ValidationError(`clarification id already exists: ${clarification.id}`);
    }
    this.clarifications.set(clarification.id, clarification);
    return clarification;
  }

  async listClarifications(
    problemId: string,
    filter: ClarificationListFilter = {},
  ): Promise<Clarification[]> {
    return [...this.clarifications.values()]
      .filter(
        (clarification) =>
          clarification.problemId === problemId &&
          (filter.status === undefined || clarification.status === filter.status),
      )
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }

  async findClarification(id: string): Promise<Clarification> {
    const clarification = this.clarifications.get(id);
    if (!clarification) {
      throw new ClarificationNotFoundError(id);
    }
    return clarification;
  }

  async answerClarification(
    id: string,
    answer: AnswerClarificationInput,
  ): Promise<Clarification> {
    const clarification = await this.findClarification(id);
    const optionId = answer.optionId?.trim();
    const text = answer.text?.trim();
    if (optionId && !clarification.options.some((option) => option.id === optionId)) {
      throw new ValidationError(
        `clarification ${id} has no option '${optionId}'`,
      );
    }
    if (!optionId && !text) {
      throw new ValidationError(
        `clarification ${id} requires an optionId or text answer`,
      );
    }
    const now = new Date().toISOString();
    const updated: Clarification = {
      ...clarification,
      status: "ANSWERED",
      answer: { optionId: optionId || undefined, text: text || undefined, createdAt: now },
      answeredAt: now,
    };
    this.clarifications.set(id, updated);
    return updated;
  }
}
