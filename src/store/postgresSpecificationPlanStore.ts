import { Pool } from "pg";
import { buildSpecificationPlanItem } from "../domain/specificationPlan.js";
import type {
  CreateSpecificationPlanItemInput,
  SpecificationPlanItem,
} from "../domain/specificationPlan.js";
import { ValidationError } from "../errors.js";
import type { SpecificationPlanStore } from "./specificationPlanStore.js";

interface PlanItemRow {
  id: string;
  specification_id: string;
  position: number;
  title: string;
  description: string;
  task_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** PostgreSQL-backed plan store (see migrations/009_specification_plans.sql). */
export class PostgresSpecificationPlanStore implements SpecificationPlanStore {
  constructor(private readonly pool: Pool) {}

  async listPlanItems(specificationId: string): Promise<SpecificationPlanItem[]> {
    const { rows } = await this.pool.query<PlanItemRow>(
      `SELECT * FROM specification_plans WHERE specification_id = $1
       ORDER BY position ASC, id ASC`,
      [specificationId],
    );
    return rows.map(rowToPlanItem);
  }

  async createPlanItem(
    input: CreateSpecificationPlanItemInput,
  ): Promise<SpecificationPlanItem> {
    const item = buildSpecificationPlanItem(input);
    try {
      const { rows } = await this.pool.query<PlanItemRow>(
        `INSERT INTO specification_plans
           (id, specification_id, position, title, description, task_id,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING *`,
        [
          item.id,
          item.specificationId,
          item.position,
          item.title,
          item.description,
          item.taskId ?? null,
          item.createdAt,
        ],
      );
      const row = rows[0];
      if (!row) {
        throw new Error("createPlanItem: no row returned");
      }
      return rowToPlanItem(row);
    } catch (error) {
      throw translateUniqueViolation(error, item);
    }
  }

  async attachTask(planItemId: string, taskId: string): Promise<SpecificationPlanItem> {
    const { rows } = await this.pool.query<PlanItemRow>(
      `UPDATE specification_plans SET task_id = $1, updated_at = $2
       WHERE id = $3
       RETURNING *`,
      [taskId, new Date().toISOString(), planItemId],
    );
    const row = rows[0];
    if (!row) {
      throw new ValidationError(`plan item not found: ${planItemId}`);
    }
    return rowToPlanItem(row);
  }

  async deletePlanItemsForSpecification(specificationId: string): Promise<void> {
    await this.pool.query("DELETE FROM specification_plans WHERE specification_id = $1", [
      specificationId,
    ]);
  }
}

function translateUniqueViolation(
  error: unknown,
  item: SpecificationPlanItem,
): unknown {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "23505") {
    return new ValidationError(
      `specification ${item.specificationId} already has a plan item at position ` +
        `${item.position} (or the task is already linked)`,
    );
  }
  return error;
}

function rowToPlanItem(row: PlanItemRow): SpecificationPlanItem {
  return {
    id: row.id,
    specificationId: row.specification_id,
    position: row.position,
    title: row.title,
    description: row.description,
    taskId: row.task_id ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
