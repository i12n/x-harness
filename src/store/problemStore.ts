import type {
  AnswerClarificationInput,
  Clarification,
  ClarificationStatus,
  CreateClarificationInput,
  CreateProblemAnalysisInput,
  CreateProblemInput,
  Problem,
  ProblemAnalysis,
  ProblemSpec,
  ProblemStatus,
} from "../domain/problem.js";

export interface ProblemListFilter {
  status?: ProblemStatus;
  repositoryId?: string;
}

export interface ClarificationListFilter {
  status?: ClarificationStatus;
}

/** Persistence contract for the Problem Confirmation Loop. */
export interface ProblemStore {
  createProblem(input: CreateProblemInput): Promise<Problem>;
  listProblems(filter?: ProblemListFilter): Promise<Problem[]>;
  findProblem(id: string): Promise<Problem>;
  updateProblemStatus(id: string, status: ProblemStatus): Promise<Problem>;
  setProblemSpec(id: string, spec: ProblemSpec): Promise<Problem>;

  addAnalysis(input: CreateProblemAnalysisInput): Promise<ProblemAnalysis>;
  listAnalyses(problemId: string): Promise<ProblemAnalysis[]>;

  createClarification(input: CreateClarificationInput): Promise<Clarification>;
  listClarifications(
    problemId: string,
    filter?: ClarificationListFilter,
  ): Promise<Clarification[]>;
  findClarification(id: string): Promise<Clarification>;
  answerClarification(
    id: string,
    answer: AnswerClarificationInput,
  ): Promise<Clarification>;
}
