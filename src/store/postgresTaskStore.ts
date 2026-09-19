import { Pool } from "pg";
import { buildTask, withTaskReview } from "../domain/task.js";
import type {
  CreateTaskInput,
  Task,
  TaskReview,
  TaskStatus,
} from "../domain/task.js";
import type { TargetRole, TaskTarget } from "../domain/taskTarget.js";
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

interface TargetRow {
  id: string;
  task_id: string;
  repository_id: string;
  role: string;
  position: number;
  base_ref: string | null;
  required: boolean;
  created_at: Date | string;
}

/** PostgreSQL-backed task store (see migrations/001_init.sql). */
export class PostgresTaskStore implements TaskStore {
  constructor(private readonly pool: Pool) {}

  async createTask(input: CreateTaskInput): Promise<Task> {
    const task = buildTask(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tasks
           (id, repository_id, title, description, status, priority,
            acceptance, constraints, max_attempts, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
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
      for (const target of task.targets) {
        await client.query(
          `INSERT INTO task_targets
             (id, task_id, repository_id, role, position, base_ref, required, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            target.id,
            target.taskId,
            target.repositoryId,
            target.role,
            target.position,
            target.baseRef ?? null,
            target.required,
            target.createdAt,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return task;
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
    const tasks: Task[] = [];
    for (const row of rows) {
      tasks.push(rowToTask(row, await this.loadTargets(row.id)));
    }
    return tasks;
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
    return rowToTask(row, await this.loadTargets(id));
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
    return rowToTask(row, await this.loadTargets(id));
  }

  async appendTaskReview(id: string, review: TaskReview): Promise<Task> {
    const current = await this.findTask(id);
    const constraints = withTaskReview(current, review);
    const now = new Date().toISOString();
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE tasks SET constraints = $1::jsonb, updated_at = $2
       WHERE id = $3
       RETURNING *`,
      [JSON.stringify(constraints), now, id],
    );
    const row = rows[0];
    if (!row) {
      throw new TaskNotFoundError(id);
    }
    return rowToTask(row, await this.loadTargets(id));
  }

  private async loadTargets(taskId: string): Promise<TaskTarget[]> {
    const { rows } = await this.pool.query<TargetRow>(
      `SELECT * FROM task_targets WHERE task_id = $1 ORDER BY position ASC, id ASC`,
      [taskId],
    );
    return rows.map(rowToTarget);
  }
}

function rowToTask(row: TaskRow, targets: TaskTarget[]): Task {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    targets,
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

function rowToTarget(row: TargetRow): TaskTarget {
  return {
    id: row.id,
    taskId: row.task_id,
    repositoryId: row.repository_id,
    role: row.role as TargetRole,
    position: row.position,
    baseRef: row.base_ref ?? undefined,
    required: row.required,
    createdAt: toIso(row.created_at),
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
