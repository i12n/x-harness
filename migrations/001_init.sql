-- AI Coding Harness v0.1 initial schema (5 core tables).

CREATE TABLE repositories (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    default_branch  TEXT NOT NULL DEFAULT 'main',
    local_path      TEXT NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,

    repository_id   TEXT NOT NULL
                    REFERENCES repositories(id),

    title           TEXT NOT NULL,
    description     TEXT NOT NULL,

    status          TEXT NOT NULL,

    priority        INTEGER NOT NULL DEFAULT 50,

    acceptance      JSONB NOT NULL DEFAULT '[]',
    constraints     JSONB NOT NULL DEFAULT '{}',

    max_attempts    INTEGER NOT NULL DEFAULT 3,

    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE runs (
    id              TEXT PRIMARY KEY,

    task_id         TEXT NOT NULL
                    REFERENCES tasks(id),

    status          TEXT NOT NULL,

    attempt         INTEGER NOT NULL,

    agent           TEXT NOT NULL,
    engine          TEXT NOT NULL,

    worker_id       TEXT,

    lease_until     TIMESTAMPTZ,

    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,

    exit_code       INTEGER,

    result          JSONB,
    error           JSONB,

    created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,

    run_id          TEXT NOT NULL
                    REFERENCES runs(id),

    repository_id   TEXT NOT NULL
                    REFERENCES repositories(id),

    path            TEXT NOT NULL,

    branch          TEXT NOT NULL,

    status          TEXT NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL,
    removed_at      TIMESTAMPTZ
);

CREATE TABLE events (
    id          BIGSERIAL PRIMARY KEY,

    type        TEXT NOT NULL,

    task_id     TEXT,
    run_id      TEXT,

    payload     JSONB NOT NULL,

    created_at  TIMESTAMPTZ NOT NULL
);
