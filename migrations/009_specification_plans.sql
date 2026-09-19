-- Phase 12 / TASK-1202: Specification → Task Planning.
--
-- One row per plan item (= one Task). A Specification has N plan items, so
-- there is deliberately NO unique(specification_id): the "plan this
-- specification exactly once" guard is the conditional status transition
-- READY → PLANNED plus unique(specification_id, position) below, and Task
-- creation is idempotent through the deterministic `tasks.id` / `plan id`.
--
-- Idempotent so it can be re-applied by the dev-grade migration runner.

CREATE TABLE IF NOT EXISTS specification_plans (
    id                TEXT PRIMARY KEY,

    specification_id  TEXT NOT NULL REFERENCES specifications(id),

    position          INTEGER NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',

    -- Filled in right after the Task exists (see PlanningService).
    task_id           TEXT REFERENCES tasks(id),

    created_at        TIMESTAMPTZ NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL,

    UNIQUE (specification_id, position),   -- one plan item per slot
    UNIQUE (task_id)                       -- one task belongs to one plan item
);

CREATE INDEX IF NOT EXISTS specification_plans_specification_idx
    ON specification_plans (specification_id, position);
