import { Pool } from "pg";
import { buildTaskDependency } from "../domain/taskDependency.js";
import type {
  AddTaskDependencyInput,
  TaskDependency,
} from "../domain/taskDependency.js";
import { DuplicateTaskDependencyError, ValidationError } from "../errors.js";
import type { TaskDependencyStore } from "./taskDependencyStore.js";

interface DependencyRow {
  task_id: string;
  depends_on_task_id: string;
  created_at: Date | string;
}

/** PostgreSQL-backed dependency store (migrations/010_task_dependencies.sql). */
export class PostgresTaskDependencyStore implements TaskDependencyStore {
  constructor(private readonly pool: Pool) {}

  async addDependency(input: AddTaskDependencyInput): Promise<TaskDependency> {
    const dependency = buildTaskDependency(input);
    try {
      const { rows } = await this.pool.query<DependencyRow>(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [dependency.taskId, dependency.dependsOnTaskId, dependency.createdAt],
      );
      const row = rows[0];
      if (!row) {
        throw new Error("addDependency: no row returned");
      }
      return rowToDependency(row);
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === "23505") {
        throw new DuplicateTaskDependencyError(
          dependency.taskId,
          dependency.dependsOnTaskId,
        );
      }
      if (code === "23514") {
        throw new ValidationError(
          `task ${dependency.taskId} cannot depend on itself`,
        );
      }
      throw error;
    }
  }

  async findDependency(
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<TaskDependency | undefined> {
    const { rows } = await this.pool.query<DependencyRow>(
      `SELECT * FROM task_dependencies
       WHERE task_id = $1 AND depends_on_task_id = $2`,
      [taskId, dependsOnTaskId],
    );
    const row = rows[0];
    return row ? rowToDependency(row) : undefined;
  }

  async listDependencies(taskId: string): Promise<TaskDependency[]> {
    const { rows } = await this.pool.query<DependencyRow>(
      `SELECT * FROM task_dependencies WHERE task_id = $1
       ORDER BY created_at ASC, depends_on_task_id ASC`,
      [taskId],
    );
    return rows.map(rowToDependency);
  }

  async listDependents(dependsOnTaskId: string): Promise<TaskDependency[]> {
    const { rows } = await this.pool.query<DependencyRow>(
      `SELECT * FROM task_dependencies WHERE depends_on_task_id = $1
       ORDER BY created_at ASC, task_id ASC`,
      [dependsOnTaskId],
    );
    return rows.map(rowToDependency);
  }

  async listAllDependencies(): Promise<TaskDependency[]> {
    const { rows } = await this.pool.query<DependencyRow>(
      "SELECT * FROM task_dependencies ORDER BY task_id ASC, depends_on_task_id ASC",
    );
    return rows.map(rowToDependency);
  }
}

function rowToDependency(row: DependencyRow): TaskDependency {
  return {
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
