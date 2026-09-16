import { Pool } from "pg";
import { buildExecutionRecord } from "../domain/execution.js";
import type {
  CreateExecutionInput,
  ExecutionRecord,
  ExecutionStatus,
} from "../domain/execution.js";
import { ExecutionNotFoundError } from "../errors.js";
import type {
  ExecutionListFilter,
  ExecutionStore,
  UpdateExecutionInput,
} from "./executionStore.js";

interface ExecutionRow {
  id: string;
  run_id: string;
  driver: string;
  status: string;
  container_id: string | null;
  workspace_path: string;
  workdir: string;
  profile_name: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  cleaned_at: Date | string | null;
  error: unknown;
}

export class PostgresExecutionStore implements ExecutionStore {
  constructor(private readonly pool: Pool) {}

  async createExecution(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const execution = buildExecutionRecord(input);
    const { rows } = await this.pool.query<ExecutionRow>(
      `INSERT INTO executions
         (id, run_id, driver, status, container_id, workspace_path, workdir,
          profile_name, created_at, started_at, finished_at, cleaned_at, error)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,NULL,NULL,NULL,NULL)
       RETURNING *`,
      [
        execution.id,
        execution.runId,
        execution.driver,
        execution.status,
        execution.workspacePath,
        execution.workdir,
        execution.profileName ?? null,
        execution.createdAt,
      ],
    );
    return rowToExecution(requireRow(rows, "createExecution"));
  }

  async findExecution(id: string): Promise<ExecutionRecord> {
    const { rows } = await this.pool.query<ExecutionRow>(
      "SELECT * FROM executions WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new ExecutionNotFoundError(id);
    }
    return rowToExecution(row);
  }

  async findLatestByRunId(runId: string): Promise<ExecutionRecord | undefined> {
    const { rows } = await this.pool.query<ExecutionRow>(
      `SELECT * FROM executions WHERE run_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [runId],
    );
    return rows[0] ? rowToExecution(rows[0]) : undefined;
  }

  async listExecutions(filter: ExecutionListFilter = {}): Promise<ExecutionRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.runId !== undefined) {
      params.push(filter.runId);
      conditions.push(`run_id = $${params.length}`);
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      params.push(filter.statuses);
      conditions.push(`status = ANY($${params.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<ExecutionRow>(
      `SELECT * FROM executions ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(rowToExecution);
  }

  async updateExecution(
    id: string,
    update: UpdateExecutionInput,
  ): Promise<ExecutionRecord> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (update.status !== undefined) push("status", update.status);
    if (update.containerId !== undefined) push("container_id", update.containerId);
    if (update.error !== undefined) push("error", JSON.stringify(update.error));
    if (update.startedAt !== undefined) push("started_at", update.startedAt);
    if (update.finishedAt !== undefined) push("finished_at", update.finishedAt);
    if (update.cleanedAt !== undefined) push("cleaned_at", update.cleanedAt);
    if (sets.length === 0) {
      return this.findExecution(id);
    }
    params.push(id);
    const { rows } = await this.pool.query<ExecutionRow>(
      `UPDATE executions SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    const row = rows[0];
    if (!row) {
      throw new ExecutionNotFoundError(id);
    }
    return rowToExecution(row);
  }
}

function rowToExecution(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    driver: row.driver,
    status: row.status as ExecutionStatus,
    containerId: row.container_id ?? undefined,
    workspacePath: row.workspace_path,
    workdir: row.workdir,
    profileName: row.profile_name ?? undefined,
    createdAt: toIso(row.created_at),
    startedAt: row.started_at ? toIso(row.started_at) : undefined,
    finishedAt: row.finished_at ? toIso(row.finished_at) : undefined,
    cleanedAt: row.cleaned_at ? toIso(row.cleaned_at) : undefined,
    error: parseJson(row.error),
  };
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

function requireRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`${label}: no row returned`);
  }
  return row;
}
