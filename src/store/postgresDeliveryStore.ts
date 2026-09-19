import { Pool } from "pg";
import { buildDelivery, buildRelease } from "../domain/delivery.js";
import type {
  CreateDeliveryInput,
  CreateReleaseInput,
  Delivery,
  DeliveryStatus,
  Release,
  ReleaseStatus,
} from "../domain/delivery.js";
import {
  DeliveryNotFoundError,
  ValidationError,
} from "../errors.js";
import type { DeliveryListFilter, DeliveryStore } from "./deliveryStore.js";

interface DeliveryRow {
  id: string;
  specification_id: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ReleaseRow {
  id: string;
  delivery_id: string;
  status: string;
  created_by: string | null;
  created_at: Date | string;
  released_at: Date | string | null;
}

/** PostgreSQL-backed delivery/release store (migrations/012_deliveries.sql). */
export class PostgresDeliveryStore implements DeliveryStore {
  constructor(private readonly pool: Pool) {}

  async createDelivery(input: CreateDeliveryInput): Promise<Delivery> {
    const delivery = buildDelivery(input);
    try {
      const { rows } = await this.pool.query<DeliveryRow>(
        `INSERT INTO deliveries
           (id, specification_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING *`,
        [delivery.id, delivery.specificationId, delivery.status, delivery.createdAt],
      );
      const row = rows[0];
      if (!row) {
        throw new Error("createDelivery: no row returned");
      }
      return rowToDelivery(row);
    } catch (error) {
      const detail = error as { code?: string; constraint?: string } | undefined;
      if (detail?.code === "23505") {
        throw new ValidationError(
          `specification ${delivery.specificationId} already has a delivery`,
        );
      }
      throw error;
    }
  }

  async findDelivery(id: string): Promise<Delivery> {
    const { rows } = await this.pool.query<DeliveryRow>(
      "SELECT * FROM deliveries WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new DeliveryNotFoundError(id);
    }
    return rowToDelivery(row);
  }

  async findDeliveryBySpecification(
    specificationId: string,
  ): Promise<Delivery | undefined> {
    const { rows } = await this.pool.query<DeliveryRow>(
      "SELECT * FROM deliveries WHERE specification_id = $1",
      [specificationId],
    );
    const row = rows[0];
    return row ? rowToDelivery(row) : undefined;
  }

  async listDeliveries(filter: DeliveryListFilter = {}): Promise<Delivery[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.specificationId !== undefined) {
      params.push(filter.specificationId);
      conditions.push(`specification_id = $${params.length}`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT * FROM deliveries ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(rowToDelivery);
  }

  async updateDeliveryStatus(id: string, status: DeliveryStatus): Promise<Delivery> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `UPDATE deliveries SET status = $1, updated_at = $2
       WHERE id = $3
       RETURNING *`,
      [status, new Date().toISOString(), id],
    );
    const row = rows[0];
    if (!row) {
      throw new DeliveryNotFoundError(id);
    }
    return rowToDelivery(row);
  }

  async updateDeliveryStatusIf(
    id: string,
    expected: DeliveryStatus,
    status: DeliveryStatus,
  ): Promise<Delivery | undefined> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `UPDATE deliveries SET status = $1, updated_at = $2
       WHERE id = $3 AND status = $4
       RETURNING *`,
      [status, new Date().toISOString(), id, expected],
    );
    const row = rows[0];
    if (row) {
      return rowToDelivery(row);
    }
    const { rows: existing } = await this.pool.query(
      "SELECT id FROM deliveries WHERE id = $1",
      [id],
    );
    if (existing.length === 0) {
      throw new DeliveryNotFoundError(id);
    }
    return undefined;
  }

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    const release = buildRelease(input);
    try {
      const { rows } = await this.pool.query<ReleaseRow>(
        `INSERT INTO releases
           (id, delivery_id, status, created_by, created_at, released_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          release.id,
          release.deliveryId,
          release.status,
          release.createdBy ?? null,
          release.createdAt,
          release.releasedAt ?? null,
        ],
      );
      const row = rows[0];
      if (!row) {
        throw new Error("createRelease: no row returned");
      }
      return rowToRelease(row);
    } catch (error) {
      const detail = error as { code?: string; constraint?: string } | undefined;
      if (detail?.code === "23505") {
        // releases_one_released_idx: the delivery already has a RELEASED row.
        throw new ValidationError(`delivery ${release.deliveryId} is already released`);
      }
      throw error;
    }
  }

  async listReleases(deliveryId: string): Promise<Release[]> {
    const { rows } = await this.pool.query<ReleaseRow>(
      `SELECT * FROM releases WHERE delivery_id = $1
       ORDER BY created_at ASC, id ASC`,
      [deliveryId],
    );
    return rows.map(rowToRelease);
  }

  async findReleasedRelease(deliveryId: string): Promise<Release | undefined> {
    const { rows } = await this.pool.query<ReleaseRow>(
      `SELECT * FROM releases WHERE delivery_id = $1 AND status = 'RELEASED'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [deliveryId],
    );
    const row = rows[0];
    return row ? rowToRelease(row) : undefined;
  }
}

function rowToDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    specificationId: row.specification_id,
    status: row.status as DeliveryStatus,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToRelease(row: ReleaseRow): Release {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    status: row.status as ReleaseStatus,
    createdBy: row.created_by ?? undefined,
    createdAt: toIso(row.created_at),
    releasedAt: row.released_at ? toIso(row.released_at) : undefined,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
