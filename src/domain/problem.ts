import { ValidationError } from "../errors.js";
import { makeId } from "../util/id.js";
import { dedupeNonEmpty } from "../util/strings.js";

/** Problem lifecycle (see docs/problem-confirmation-loop.md section 12). */
export const PROBLEM_STATUSES = [
  "INBOX",
  "ANALYZING",
  "NEEDS_INPUT",
  "ANSWERED",
  "CONFIRMED",
  "INVESTIGATING",
  "SPECIFIED",
  "READY",
] as const;

export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export const CLARIFICATION_TYPES = ["fact", "scope", "decision", "constraint"] as const;
export type ClarificationType = (typeof CLARIFICATION_TYPES)[number];

export const CLARIFICATION_STATUSES = ["OPEN", "ANSWERED", "DISMISSED"] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];

/** The "what is the problem / what is expected" summary once confirmed. */
export interface ProblemSpec {
  problem: string;
  expected: string;
  scope?: string;
  investigation?: string;
}

export interface Problem {
  id: string;
  repositoryId?: string;
  title: string;
  statement: string;
  status: ProblemStatus;
  confirmedSpec?: ProblemSpec;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProblemInput {
  id?: string;
  repositoryId?: string;
  title: string;
  statement: string;
  status?: ProblemStatus;
}

export function isProblemStatus(value: unknown): value is ProblemStatus {
  return typeof value === "string" && (PROBLEM_STATUSES as readonly string[]).includes(value);
}

export function isClarificationType(value: unknown): value is ClarificationType {
  return typeof value === "string" && (CLARIFICATION_TYPES as readonly string[]).includes(value);
}

export function isClarificationStatus(value: unknown): value is ClarificationStatus {
  return typeof value === "string" && (CLARIFICATION_STATUSES as readonly string[]).includes(value);
}

export function buildProblem(input: CreateProblemInput): Problem {
  const title = input.title.trim();
  if (!title) {
    throw new ValidationError("problem title is required");
  }
  const statement = input.statement.trim();
  if (!statement) {
    throw new ValidationError("problem statement is required");
  }
  const status = input.status ?? "INBOX";
  if (!isProblemStatus(status)) {
    throw new ValidationError(`invalid problem status: ${String(status)}`);
  }
  const now = new Date().toISOString();
  const repositoryId = input.repositoryId?.trim();
  return {
    id: input.id?.trim() || makeId("prob"),
    repositoryId: repositoryId || undefined,
    title,
    statement,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

export interface ProblemAnalysis {
  id: string;
  problemId: string;
  summary: string;
  uncertainties: string[];
  needsInput: boolean;
  createdAt: string;
}

export interface CreateProblemAnalysisInput {
  id?: string;
  problemId: string;
  summary: string;
  uncertainties?: string[];
  needsInput: boolean;
}

export function buildProblemAnalysis(input: CreateProblemAnalysisInput): ProblemAnalysis {
  const summary = input.summary.trim();
  if (!summary) {
    throw new ValidationError("analysis summary is required");
  }
  return {
    id: input.id?.trim() || makeId("anlz"),
    problemId: input.problemId,
    summary,
    uncertainties: dedupeNonEmpty(input.uncertainties ?? []),
    needsInput: input.needsInput,
    createdAt: new Date().toISOString(),
  };
}

export interface ClarificationOption {
  id: string;
  label: string;
}

export interface ClarificationAnswer {
  optionId?: string;
  text?: string;
  createdAt: string;
}

export interface Clarification {
  id: string;
  problemId: string;
  question: string;
  type: ClarificationType;
  required: boolean;
  options: ClarificationOption[];
  reason: string;
  status: ClarificationStatus;
  answer?: ClarificationAnswer;
  createdAt: string;
  answeredAt?: string;
}

export interface CreateClarificationInput {
  id?: string;
  problemId: string;
  question: string;
  type: ClarificationType;
  required?: boolean;
  options?: ClarificationOption[];
  reason?: string;
  status?: ClarificationStatus;
}

export function buildClarification(input: CreateClarificationInput): Clarification {
  const question = input.question.trim();
  if (!question) {
    throw new ValidationError("clarification question is required");
  }
  if (!isClarificationType(input.type)) {
    throw new ValidationError(`invalid clarification type: ${String(input.type)}`);
  }
  const status = input.status ?? "OPEN";
  if (!isClarificationStatus(status)) {
    throw new ValidationError(`invalid clarification status: ${String(status)}`);
  }
  const options: ClarificationOption[] = [];
  const seen = new Set<string>();
  for (const option of input.options ?? []) {
    const id = option.id.trim();
    const label = option.label.trim();
    if (!id || !label || seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push({ id, label });
  }
  return {
    id: input.id?.trim() || makeId("clar"),
    problemId: input.problemId,
    question,
    type: input.type,
    required: input.required ?? true,
    options,
    reason: input.reason?.trim() ?? "",
    status,
    createdAt: new Date().toISOString(),
  };
}

export interface AnswerClarificationInput {
  optionId?: string;
  text?: string;
}
