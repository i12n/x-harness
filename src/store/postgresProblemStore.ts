import { Pool } from "pg";
import {
  buildClarification,
  buildProblem,
  buildProblemAnalysis,
} from "../domain/problem.js";
import type {
  AnswerClarificationInput,
  Clarification,
  ClarificationOption,
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
  ProblemNotFoundError,
  ValidationError,
} from "../errors.js";
import { makeId } from "../util/id.js";
import type {
  ClarificationListFilter,
  ProblemListFilter,
  ProblemStore,
} from "./problemStore.js";

interface ProblemRow {
  id: string;
  repository_id: string | null;
  title: string;
  statement: string;
  status: string;
  confirmed_spec: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AnalysisRow {
  id: string;
  problem_id: string;
  summary: string;
  uncertainties: unknown;
  needs_input: boolean;
  created_at: Date | string;
}

interface ClarificationRow {
  id: string;
  problem_id: string;
  question: string;
  type: string;
  required: boolean;
  options: unknown;
  reason: string;
  status: string;
  created_at: Date | string;
  answered_at: Date | string | null;
}

interface AnswerRow {
  id: string;
  clarification_id: string;
  option_id: string | null;
  text: string | null;
  created_at: Date | string;
}

/** PostgreSQL-backed problem store (see migrations/002_problems.sql). */
export class PostgresProblemStore implements ProblemStore {
  constructor(private readonly pool: Pool) {}

  async createProblem(input: CreateProblemInput): Promise<Problem> {
    const problem = buildProblem(input);
    const { rows } = await this.pool.query<ProblemRow>(
      `INSERT INTO problems
         (id, repository_id, title, statement, status, confirmed_spec, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $6)
       RETURNING *`,
      [
        problem.id,
        problem.repositoryId ?? null,
        problem.title,
        problem.statement,
        problem.status,
        problem.createdAt,
      ],
    );
    return rowToProblem(requireRow(rows, "createProblem"));
  }

  async listProblems(filter: ProblemListFilter = {}): Promise<Problem[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.repositoryId !== undefined) {
      params.push(filter.repositoryId);
      conditions.push(`repository_id = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<ProblemRow>(
      `SELECT * FROM problems ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(rowToProblem);
  }

  async findProblem(id: string): Promise<Problem> {
    const { rows } = await this.pool.query<ProblemRow>(
      "SELECT * FROM problems WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new ProblemNotFoundError(id);
    }
    return rowToProblem(row);
  }

  async updateProblemStatus(id: string, status: ProblemStatus): Promise<Problem> {
    const { rows } = await this.pool.query<ProblemRow>(
      "UPDATE problems SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *",
      [status, new Date().toISOString(), id],
    );
    const row = rows[0];
    if (!row) {
      throw new ProblemNotFoundError(id);
    }
    return rowToProblem(row);
  }

  async setProblemSpec(id: string, spec: ProblemSpec): Promise<Problem> {
    const { rows } = await this.pool.query<ProblemRow>(
      `UPDATE problems SET confirmed_spec = $1::jsonb, updated_at = $2
       WHERE id = $3
       RETURNING *`,
      [JSON.stringify(spec), new Date().toISOString(), id],
    );
    const row = rows[0];
    if (!row) {
      throw new ProblemNotFoundError(id);
    }
    return rowToProblem(row);
  }

  async addAnalysis(input: CreateProblemAnalysisInput): Promise<ProblemAnalysis> {
    const analysis = buildProblemAnalysis(input);
    const { rows } = await this.pool.query<AnalysisRow>(
      `INSERT INTO problem_analyses
         (id, problem_id, summary, uncertainties, needs_input, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        analysis.id,
        analysis.problemId,
        analysis.summary,
        JSON.stringify(analysis.uncertainties),
        analysis.needsInput,
        analysis.createdAt,
      ],
    );
    return rowToAnalysis(requireRow(rows, "addAnalysis"));
  }

  async listAnalyses(problemId: string): Promise<ProblemAnalysis[]> {
    const { rows } = await this.pool.query<AnalysisRow>(
      "SELECT * FROM problem_analyses WHERE problem_id = $1 ORDER BY created_at ASC, id ASC",
      [problemId],
    );
    return rows.map(rowToAnalysis);
  }

  async createClarification(input: CreateClarificationInput): Promise<Clarification> {
    const clarification = buildClarification(input);
    const { rows } = await this.pool.query<ClarificationRow>(
      `INSERT INTO clarifications
         (id, problem_id, question, type, required, options, reason, status, created_at, answered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       RETURNING *`,
      [
        clarification.id,
        clarification.problemId,
        clarification.question,
        clarification.type,
        clarification.required,
        JSON.stringify(clarification.options),
        clarification.reason,
        clarification.status,
        clarification.createdAt,
      ],
    );
    return rowToClarification(requireRow(rows, "createClarification"));
  }

  async listClarifications(
    problemId: string,
    filter: ClarificationListFilter = {},
  ): Promise<Clarification[]> {
    const conditions = ["problem_id = $1"];
    const params: unknown[] = [problemId];
    if (filter.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    const { rows } = await this.pool.query<ClarificationRow>(
      `SELECT * FROM clarifications WHERE ${conditions.join(" AND ")}
       ORDER BY created_at ASC, id ASC`,
      params,
    );
    const result: Clarification[] = [];
    for (const row of rows) {
      result.push(rowToClarification(row, await this.latestAnswer(row.id)));
    }
    return result;
  }

  async findClarification(id: string): Promise<Clarification> {
    const { rows } = await this.pool.query<ClarificationRow>(
      "SELECT * FROM clarifications WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new ClarificationNotFoundError(id);
    }
    return rowToClarification(row, await this.latestAnswer(id));
  }

  async answerClarification(
    id: string,
    answer: AnswerClarificationInput,
  ): Promise<Clarification> {
    const clarification = await this.findClarification(id);
    const optionId = answer.optionId?.trim();
    const text = answer.text?.trim();
    if (optionId && !clarification.options.some((option) => option.id === optionId)) {
      throw new ValidationError(`clarification ${id} has no option '${optionId}'`);
    }
    if (!optionId && !text) {
      throw new ValidationError(`clarification ${id} requires an optionId or text answer`);
    }
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO clarification_answers (id, clarification_id, option_id, text, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [makeId("cans"), id, optionId ?? null, text ?? null, now],
    );
    await this.pool.query(
      "UPDATE clarifications SET status = 'ANSWERED', answered_at = $1 WHERE id = $2",
      [now, id],
    );
    return this.findClarification(id);
  }

  private async latestAnswer(clarificationId: string): Promise<AnswerRow | undefined> {
    const { rows } = await this.pool.query<AnswerRow>(
      `SELECT * FROM clarification_answers
       WHERE clarification_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [clarificationId],
    );
    return rows[0];
  }
}

function rowToProblem(row: ProblemRow): Problem {
  return {
    id: row.id,
    repositoryId: row.repository_id ?? undefined,
    title: row.title,
    statement: row.statement,
    status: row.status as ProblemStatus,
    confirmedSpec: parseSpec(row.confirmed_spec),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToAnalysis(row: AnalysisRow): ProblemAnalysis {
  return {
    id: row.id,
    problemId: row.problem_id,
    summary: row.summary,
    uncertainties: parseStringArray(row.uncertainties),
    needsInput: row.needs_input,
    createdAt: toIso(row.created_at),
  };
}

function rowToClarification(row: ClarificationRow, answer?: AnswerRow): Clarification {
  return {
    id: row.id,
    problemId: row.problem_id,
    question: row.question,
    type: row.type as Clarification["type"],
    required: row.required,
    options: parseOptions(row.options),
    reason: row.reason,
    status: row.status as Clarification["status"],
    answer: answer
      ? {
          optionId: answer.option_id ?? undefined,
          text: answer.text ?? undefined,
          createdAt: toIso(answer.created_at),
        }
      : undefined,
    createdAt: toIso(row.created_at),
    answeredAt: row.answered_at ? toIso(row.answered_at) : undefined,
  };
}

function parseSpec(raw: unknown): ProblemSpec | undefined {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const spec = parsed as Record<string, unknown>;
  if (typeof spec.problem !== "string" || typeof spec.expected !== "string") {
    return undefined;
  }
  return {
    problem: spec.problem,
    expected: spec.expected,
    scope: typeof spec.scope === "string" ? spec.scope : undefined,
    investigation: typeof spec.investigation === "string" ? spec.investigation : undefined,
  };
}

function parseOptions(raw: unknown): ClarificationOption[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (entry): entry is ClarificationOption =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as ClarificationOption).id === "string" &&
      typeof (entry as ClarificationOption).label === "string",
  );
}

function parseStringArray(raw: unknown): string[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function parseJson(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`${label}: no row returned`);
  }
  return row;
}
