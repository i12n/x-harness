import { Pool, type PoolClient } from "pg";
import {
  applySpecificationUpdate,
  buildSpecification,
} from "../domain/specification.js";
import type {
  CreateSpecificationInput,
  Specification,
  SpecificationStatus,
  SpecificationTarget,
  UpdateSpecificationInput,
} from "../domain/specification.js";
import type { TargetRole } from "../domain/taskTarget.js";
import { SpecificationNotFoundError } from "../errors.js";
import { makeId } from "../util/id.js";
import type {
  SpecificationListFilter,
  SpecificationStore,
} from "./specificationStore.js";

interface SpecificationRow {
  id: string;
  problem_id: string;
  title: string;
  summary: string;
  requirements: unknown;
  acceptance: unknown;
  constraints: unknown;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SpecificationTargetRow {
  specification_id: string;
  repository_id: string;
  role: string;
  position: number;
  base_ref: string | null;
}

/** PostgreSQL-backed specification store (see migrations/008_specifications.sql). */
export class PostgresSpecificationStore implements SpecificationStore {
  constructor(private readonly pool: Pool) {}

  async createSpecification(input: CreateSpecificationInput): Promise<Specification> {
    const specification = buildSpecification(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO specifications
           (id, problem_id, title, summary, requirements, acceptance, constraints,
            status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          specification.id,
          specification.problemId,
          specification.title,
          specification.summary,
          JSON.stringify(specification.requirements),
          JSON.stringify(specification.acceptance),
          JSON.stringify(specification.constraints),
          specification.status,
          specification.createdAt,
        ],
      );
      await this.replaceTargets(client, specification.id, specification.targets);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return specification;
  }

  async listSpecifications(
    filter: SpecificationListFilter = {},
  ): Promise<Specification[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.problemId !== undefined) {
      params.push(filter.problemId);
      conditions.push(`problem_id = $${params.length}`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<SpecificationRow>(
      `SELECT * FROM specifications ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    const result: Specification[] = [];
    for (const row of rows) {
      result.push(rowToSpecification(row, await this.loadTargets(row.id)));
    }
    return result;
  }

  async findSpecification(id: string): Promise<Specification> {
    const { rows } = await this.pool.query<SpecificationRow>(
      "SELECT * FROM specifications WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new SpecificationNotFoundError(id);
    }
    return rowToSpecification(row, await this.loadTargets(id));
  }

  async findSpecificationByProblem(
    problemId: string,
  ): Promise<Specification | undefined> {
    const { rows } = await this.pool.query<SpecificationRow>(
      `SELECT * FROM specifications WHERE problem_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [problemId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return rowToSpecification(row, await this.loadTargets(row.id));
  }

  async updateSpecification(
    id: string,
    patch: UpdateSpecificationInput,
  ): Promise<Specification> {
    const current = await this.findSpecification(id);
    const updated = applySpecificationUpdate(current, patch);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE specifications
         SET title = $1, summary = $2, requirements = $3::jsonb, acceptance = $4::jsonb,
             constraints = $5::jsonb, updated_at = $6
         WHERE id = $7`,
        [
          updated.title,
          updated.summary,
          JSON.stringify(updated.requirements),
          JSON.stringify(updated.acceptance),
          JSON.stringify(updated.constraints),
          updated.updatedAt,
          id,
        ],
      );
      if (rowCount === 0) {
        throw new SpecificationNotFoundError(id);
      }
      if (patch.targets !== undefined) {
        await this.replaceTargets(client, id, updated.targets);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return updated;
  }

  async updateSpecificationStatus(
    id: string,
    status: SpecificationStatus,
  ): Promise<Specification> {
    const { rows } = await this.pool.query<SpecificationRow>(
      `UPDATE specifications SET status = $1, updated_at = $2
       WHERE id = $3
       RETURNING *`,
      [status, new Date().toISOString(), id],
    );
    const row = rows[0];
    if (!row) {
      throw new SpecificationNotFoundError(id);
    }
    return rowToSpecification(row, await this.loadTargets(id));
  }

  private async replaceTargets(
    client: PoolClient,
    specificationId: string,
    targets: SpecificationTarget[],
  ): Promise<void> {
    await client.query("DELETE FROM specification_targets WHERE specification_id = $1", [
      specificationId,
    ]);
    for (const target of targets) {
      await client.query(
        `INSERT INTO specification_targets
           (id, specification_id, repository_id, role, position, base_ref)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          makeId("stgt"),
          specificationId,
          target.repositoryId,
          target.role,
          target.position,
          target.baseRef ?? null,
        ],
      );
    }
  }

  private async loadTargets(specificationId: string): Promise<SpecificationTarget[]> {
    const { rows } = await this.pool.query<SpecificationTargetRow>(
      `SELECT * FROM specification_targets WHERE specification_id = $1
       ORDER BY position ASC, repository_id ASC`,
      [specificationId],
    );
    return rows.map(rowToTarget);
  }
}

function rowToSpecification(
  row: SpecificationRow,
  targets: SpecificationTarget[],
): Specification {
  return {
    id: row.id,
    problemId: row.problem_id,
    title: row.title,
    summary: row.summary,
    requirements: parseStringArray(row.requirements),
    acceptance: parseStringArray(row.acceptance),
    constraints: parseObject(row.constraints),
    targets,
    status: row.status as SpecificationStatus,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToTarget(row: SpecificationTargetRow): SpecificationTarget {
  return {
    repositoryId: row.repository_id,
    role: row.role as TargetRole,
    position: row.position,
    baseRef: row.base_ref ?? undefined,
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
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
