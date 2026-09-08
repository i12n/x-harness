import { Pool } from "pg";
import { buildRun } from "../domain/run.js";
import type { CreateRunInput, Run, RunStatus } from "../domain/run.js";
import { RunConflictError, RunNotFoundError } from "../errors.js";
import type { CompleteRunInput, RunListFilter, RunStore } from "./runStore.js";

interface RunRow {
  id: string;
  task_id: string;
  status: string;
  attempt: number;
  agent: string;
  engine: string;
  worker_id: string | null;
  lease_until: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  exit_code: number | null;
  result: unknown;
  error: unknown;
  created_at: Date | string;
}

const INSERT_COLUMNS = `
  id, task_id, status, attempt, agent, engine,
  worker_id, lease_until, started_at, finished_at,
  exit_code, result, error, created_at
`;

/** PostgreSQL-backed run store (see migrations/001_init.sql). */
export class PostgresRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async createRun(input: CreateRunInput): Promise<Run> {
    const run = buildRun(input);
    const { rows } = await this.pool.query<RunRow>(
      `INSERT INTO runs (${INSERT_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$7)
       RETURNING *`,
      [run.id, run.taskId, run.status, run.attempt, run.agent, run.engine, run.createdAt],
    );
    return rowToRun(requireRow(rows, "createRun"));
  }

  async findRun(id: string): Promise<Run> {
    const { rows } = await this.pool.query<RunRow>(
      "SELECT * FROM runs WHERE id = $1",
      [id],
    );
    return rowToRun(requireRow(rows, `findRun(${id})`));
  }

  async listRuns(filter: RunListFilter = {}): Promise<Run[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId !== undefined) {
      params.push(filter.taskId);
      conditions.push(`task_id = $${params.length}`);
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      params.push(filter.statuses);
      conditions.push(`status = ANY($${params.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM runs ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(rowToRun);
  }

  async claimRun(id: string, workerId: string, leaseUntil: string): Promise<Run> {
    const { rows } = await this.pool.query<RunRow>(
      `UPDATE runs SET status = 'STARTING', worker_id = $1, lease_until = $2
       WHERE id = $3 AND status = 'QUEUED'
       RETURNING *`,
      [workerId, leaseUntil, id],
    );
    const row = rows[0];
    if (!row) {
      const current = await this.findOptional(id);
      if (!current) {
        throw new RunNotFoundError(id);
      }
      throw new RunConflictError(id, `status is ${current.status}`);
    }
    return rowToRun(row);
  }

  async markRunning(id: string, startedAt = new Date().toISOString()): Promise<Run> {
    const { rows } = await this.pool.query<RunRow>(
      `UPDATE runs SET status = 'RUNNING', started_at = $1
       WHERE id = $2 AND status = 'STARTING'
       RETURNING *`,
      [startedAt, id],
    );
    const row = rows[0];
    if (!row) {
      const current = await this.findOptional(id);
      if (!current) {
        throw new RunNotFoundError(id);
      }
      throw new RunConflictError(id, `status is ${current.status}`);
    }
    return rowToRun(row);
  }

  async updateRunStatus(id: string, status: RunStatus): Promise<Run> {
    const { rows } = await this.pool.query<RunRow>(
      "UPDATE runs SET status = $1 WHERE id = $2 RETURNING *",
      [status, id],
    );
    return rowToRun(requireRow(rows, `updateRunStatus(${id})`));
  }

  async touchLease(id: string, leaseUntil: string): Promise<Run> {
    const { rows } = await this.pool.query<RunRow>(
      "UPDATE runs SET lease_until = $1 WHERE id = $2 RETURNING *",
      [leaseUntil, id],
    );
    return rowToRun(requireRow(rows, `touchLease(${id})`));
  }

  async completeRun(id: string, input: CompleteRunInput): Promise<Run> {
    const { rows } = await this.pool.query<RunRow>(
      `UPDATE runs
       SET status = $1,
           exit_code = $2,
           result = $3,
           error = $4,
           finished_at = $5
       WHERE id = $6
       RETURNING *`,
      [
        input.status,
        input.exitCode ?? null,
        input.result !== undefined ? JSON.stringify(input.result) : null,
        input.error !== undefined ? JSON.stringify(input.error) : null,
        input.finishedAt ?? new Date().toISOString(),
        id,
      ],
    );
    return rowToRun(requireRow(rows, `completeRun(${id})`));
  }

  private async findOptional(id: string): Promise<Run | undefined> {
    try {
      return await this.findRun(id);
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        return undefined;
      }
      throw error;
    }
  }
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status as RunStatus,
    attempt: row.attempt,
    agent: row.agent,
    engine: row.engine,
    workerId: row.worker_id ?? undefined,
    leaseUntil: row.lease_until ? toIso(row.lease_until) : undefined,
    startedAt: row.started_at ? toIso(row.started_at) : undefined,
    finishedAt: row.finished_at ? toIso(row.finished_at) : undefined,
    exitCode: row.exit_code,
    result: parseJson(row.result),
    error: parseJson(row.error),
    createdAt: toIso(row.created_at),
  };
}

function requireRow(rows: RunRow[], label: string): RunRow {
  const row = rows[0];
  if (!row) {
    throw new Error(`${label}: no row returned`);
  }
  return row;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
