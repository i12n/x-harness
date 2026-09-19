-- Phase 12 / TASK-1201: Specification as a first-class engineering object.

CREATE TABLE IF NOT EXISTS specifications (
    id              TEXT PRIMARY KEY,

    problem_id      TEXT NOT NULL REFERENCES problems(id),

    title           TEXT NOT NULL,
    summary         TEXT NOT NULL DEFAULT '',

    requirements    JSONB NOT NULL DEFAULT '[]',
    acceptance      JSONB NOT NULL DEFAULT '[]',
    constraints     JSONB NOT NULL DEFAULT '{}',

    status          TEXT NOT NULL,   -- DRAFT | READY | PLANNED | SUPERSEDED

    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS specifications_problem_idx
    ON specifications (problem_id, created_at);

CREATE TABLE IF NOT EXISTS specification_targets (
    id                TEXT PRIMARY KEY,

    specification_id  TEXT NOT NULL REFERENCES specifications(id),
    repository_id     TEXT NOT NULL REFERENCES repositories(id),

    role              TEXT NOT NULL,   -- primary | supporting
    position          INTEGER NOT NULL,
    base_ref          TEXT,

    UNIQUE (specification_id, repository_id)
);
