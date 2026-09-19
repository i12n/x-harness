-- Phase 12 / TASK-1205: Delivery (aggregation) + Release (record).
--
--   Specification 1:1 Delivery 1:N Release
--
-- A Delivery does not own Tasks: it aggregates the Tasks produced by the
-- Specification's plan (specification_plans → tasks). No tasks.delivery_id.
--
-- Idempotent so it can be re-applied by the dev-grade migration runner.

CREATE TABLE IF NOT EXISTS deliveries (
    id                TEXT PRIMARY KEY,

    specification_id  TEXT NOT NULL REFERENCES specifications(id),

    -- Last observed aggregate (PLANNED | IN_PROGRESS | READY_FOR_RELEASE |
    -- BLOCKED | RELEASED). Recomputed from Task facts on every refresh; this
    -- column exists for edge-triggered events and for querying, not as an
    -- independent source of truth.
    status            TEXT NOT NULL,

    created_at        TIMESTAMPTZ NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL,

    UNIQUE (specification_id)          -- one Delivery per Specification
);

CREATE TABLE IF NOT EXISTS releases (
    id            TEXT PRIMARY KEY,

    delivery_id   TEXT NOT NULL REFERENCES deliveries(id),

    status        TEXT NOT NULL,       -- PENDING | RELEASED | CANCELLED

    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL,
    released_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS releases_delivery_idx
    ON releases (delivery_id, created_at);

-- At most one RELEASED release per Delivery (the DB backstop for the
-- "release once" rule); PENDING/CANCELLED rows stay unrestricted, so a later
-- versioning/rollback model is not locked out.
CREATE UNIQUE INDEX IF NOT EXISTS releases_one_released_idx
    ON releases (delivery_id)
    WHERE status = 'RELEASED';
