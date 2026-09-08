import { Pool } from "pg";
import { buildTask } from "../domain/task.js";
import type {
  CreateTaskInput,
  Task,
  TaskStatus,
} from "../domain/task.js";
import { TaskNotFoundError } from "../errors.js";
import type { TaskListFilter, TaskStore } from "./taskStore.js";

interface TaskRow {
  id: string;
  repository_id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  acceptance: unknown;
  constraints: unknown;
  max_attempts: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/** PostgreSQL-backed task store (see migrations/001_init.sql). */
export class PostgresTaskStore implements TaskStore {
  constructor(private readonly pool: Pool) {}

  async createTask(input: CreateTaskInput): Promise<Task> {
    const task = buildTask(input);
    const { rows } = await this.pool.query<TaskRow>(
      `INSERT INTO tasks
         (id, repository_id, title, description, status, priority,
          acceptance, constraints, max_attempts, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        task.id,
        task.repositoryId,
        task.title,
        task.description,
        task.status,
        task.priority,
        JSON.stringify(task.acceptance),
        JSON.stringify(task.constraints),
        task.maxAttempts,
        task.createdAt,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("createTask: insert returned no row");
    }
    return rowToTask(row);
  }

  async listTasks(filter: TaskListFilter = {}): Promise<Task[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.repositoryId !== undefined) {
      params.push(filter.repositoryId);
      conditions.push(`repository_id = $${params.length}`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT * FROM tasks ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(rowToTask);
  }

  async findTask(id: string): Promise<Task> {
    const { rows } = await this.pool.query<TaskRow>(
      "SELECT * FROM tasks WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new TaskNotFoundError(id);
    }
    return rowToTask(row);
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    const now = new Date().toISOString();
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
      [status, now, id],
    );
    const row = rows[0];
    if (!row) {
      throw new TaskNotFoundError(id);
    }
    return rowToTask(row);
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority,
    acceptance: parseStringArray(row.acceptance),
    constraints: parseObject(row.constraints),
    maxAttempts: row.max_attempts,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function parseStringArray(raw: unknown): string[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function parseObject(raw: unknown): Record<string, unknown> {
  const parsed = parseJson(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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
