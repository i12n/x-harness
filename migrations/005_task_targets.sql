-- Phase 10 / TASK-1002: multi-repository task targets.
--
-- Idempotent so it can be re-applied by the dev-grade migration runner.

CREATE TABLE IF NOT EXISTS task_targets (
    id              TEXT PRIMARY KEY,

    task_id         TEXT NOT NULL REFERENCES tasks(id),
    repository_id   TEXT NOT NULL REFERENCES repositories(id),

    role            TEXT NOT NULL,              -- primary | supporting
    position        INTEGER NOT NULL,
    base_ref        TEXT,
    required        BOOLEAN NOT NULL DEFAULT TRUE,

    created_at      TIMESTAMPTZ NOT NULL,

    UNIQUE (task_id, repository_id)             -- no duplicate repo per task
);

CREATE INDEX IF NOT EXISTS task_targets_task_id_idx ON task_targets (task_id);

-- Backfill: every existing task becomes a single primary target.
INSERT INTO task_targets
    (id, task_id, repository_id, role, position, base_ref, required, created_at)
SELECT
    'tgt-' || id, id, repository_id, 'primary', 0, NULL, TRUE, created_at
FROM tasks
ON CONFLICT DO NOTHING;

-- One workspace per (run, target); legacy rows keep NULL.
ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS task_target_id TEXT REFERENCES task_targets(id);

-- Execution evidence for multi-mount runs (host path / container path / primary).
ALTER TABLE executions
    ADD COLUMN IF NOT EXISTS mounts JSONB;
