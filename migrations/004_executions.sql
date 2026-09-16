-- Execution lifecycle records: cleanup obligation survives worker crashes.

CREATE TABLE executions (
    id              TEXT PRIMARY KEY,

    run_id          TEXT NOT NULL REFERENCES runs(id),

    driver          TEXT NOT NULL,
    status          TEXT NOT NULL,

    container_id    TEXT,

    workspace_path  TEXT NOT NULL,
    workdir         TEXT NOT NULL,
    profile_name    TEXT,

    created_at      TIMESTAMPTZ NOT NULL,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    cleaned_at      TIMESTAMPTZ,

    error           JSONB
);

CREATE INDEX executions_run_id_idx ON executions (run_id);
