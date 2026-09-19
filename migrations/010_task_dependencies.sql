-- Phase 12 / TASK-1203: Task dependencies (DAG edges).
--
--   task_id            depends on →   depends_on_task_id
--
-- The edge lives on the Task layer (never in tasks.constraints) and may cross
-- Specifications: a Task in Specification B can depend on a Task in
-- Specification A.
--
-- Idempotent so it can be re-applied by the dev-grade migration runner.

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id            TEXT NOT NULL REFERENCES tasks(id),
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
    created_at         TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (task_id, depends_on_task_id),   -- no duplicate edge
    CHECK (task_id <> depends_on_task_id)        -- no self dependency
);

-- Reverse lookup ("which tasks wait for this one"); the forward lookup is
-- served by the primary key prefix (task_id, depends_on_task_id).
CREATE INDEX IF NOT EXISTS task_dependencies_depends_on_idx
    ON task_dependencies (depends_on_task_id);
