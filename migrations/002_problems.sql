-- Problem Confirmation Loop: problem / analysis / clarification / answer.

CREATE TABLE problems (
    id              TEXT PRIMARY KEY,

    -- Nullable: the repository is often chosen during Specification.
    repository_id   TEXT REFERENCES repositories(id),

    title           TEXT NOT NULL,
    statement       TEXT NOT NULL,

    status          TEXT NOT NULL,

    confirmed_spec  JSONB,

    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE problem_analyses (
    id              TEXT PRIMARY KEY,

    problem_id      TEXT NOT NULL REFERENCES problems(id),

    summary         TEXT NOT NULL,
    uncertainties   JSONB NOT NULL DEFAULT '[]',
    needs_input     BOOLEAN NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE clarifications (
    id              TEXT PRIMARY KEY,

    problem_id      TEXT NOT NULL REFERENCES problems(id),

    question        TEXT NOT NULL,
    type            TEXT NOT NULL,
    required        BOOLEAN NOT NULL DEFAULT TRUE,
    options         JSONB NOT NULL DEFAULT '[]',
    reason          TEXT NOT NULL DEFAULT '',

    status          TEXT NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL,
    answered_at     TIMESTAMPTZ
);

CREATE TABLE clarification_answers (
    id                TEXT PRIMARY KEY,

    clarification_id  TEXT NOT NULL REFERENCES clarifications(id),

    option_id         TEXT,
    text              TEXT,

    created_at        TIMESTAMPTZ NOT NULL
);
