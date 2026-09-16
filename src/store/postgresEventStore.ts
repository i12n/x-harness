import { Pool } from "pg";
import type { EventRecord, RecordEventInput } from "../domain/event.js";
import type { EventListFilter, EventStore } from "./eventStore.js";

interface EventRow {
  id: string;
  type: string;
  task_id: string | null;
  run_id: string | null;
  problem_id: string | null;
  payload: unknown;
  created_at: Date | string;
}

/** PostgreSQL-backed event store (events table in 001_init.sql). */
export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordEventInput): Promise<EventRecord> {
    const { rows } = await this.pool.query<EventRow>(
      `INSERT INTO events (type, task_id, run_id, problem_id, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.type,
        input.taskId ?? null,
        input.runId ?? null,
        input.problemId ?? null,
        JSON.stringify(input.payload ?? {}),
        new Date().toISOString(),
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("record event: no row returned");
    }
    return rowToEvent(row);
  }

  async listEvents(filter: EventListFilter = {}): Promise<EventRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId !== undefined) {
      params.push(filter.taskId);
      conditions.push(`task_id = $${params.length}`);
    }
    if (filter.runId !== undefined) {
      params.push(filter.runId);
      conditions.push(`run_id = $${params.length}`);
    }
    if (filter.type !== undefined) {
      params.push(filter.type);
      conditions.push(`type = $${params.length}`);
    }
    if (filter.problemId !== undefined) {
      params.push(filter.problemId);
      conditions.push(`problem_id = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit =
      filter.limit !== undefined && filter.limit > 0 ? `LIMIT ${filter.limit}` : "";
    const { rows } = await this.pool.query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY id ASC ${limit}`,
      params,
    );
    return rows.map(rowToEvent);
  }
}

function rowToEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    type: row.type,
    taskId: row.task_id ?? undefined,
    runId: row.run_id ?? undefined,
    problemId: row.problem_id ?? undefined,
    payload: parseJson(row.payload),
    createdAt: toIso(row.created_at),
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
