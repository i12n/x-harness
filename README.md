# ai-harness

**AI Coding Harness v0.1** — a task-driven harness that runs end-to-end coding
tasks against multiple repositories:

```text
Repository -> Task -> Run -> Workspace -> Codex CLI -> Verification -> Review
```

Implemented in TypeScript (Node >= 18, ESM). The full plan lives in
[docs/ai-coding-harness-v0.1.md](docs/ai-coding-harness-v0.1.md).

## Status

- Phase 1 (Repository): `repository create / list / show` — done.
- Phase 2 (Task): `task create / list / show / validate` (INBOX -> READY /
  BLOCKED intake) — done.
- Phase 3 (Workspace): one Run = one independent git worktree — done.
- Phase 4+ (Codex Adapter, Verification, Worker, Scheduler, Loop): following
  the phase order in the plan.

## Requirements

- Node.js >= 18
- PostgreSQL for the default store (`docker compose up -d`, or any Postgres
  reachable via `DATABASE_URL`)

No Postgres available? Use the in-memory store for demos:
`AI_STORAGE=memory ai repository ...` (data is not persisted).

## Setup

```bash
npm install
npm test                 # vitest unit tests
npm run typecheck        # strict TypeScript check
npm run build            # compile to dist/
npm run demo:repository  # Phase 1 acceptance demo (in-memory, no DB)
npm run demo:task        # Phase 2 acceptance demo (in-memory, no DB)
npm run demo:workspace   # Phase 3 acceptance demo (git worktrees)

npm run db:migrate       # apply migrations/ against Postgres
```

## Usage

```bash
ai repository create \
  --name my-app \
  --url git@github.com:example/my-app.git \
  --verify "npm run lint" \
  --verify "npm test" \
  --verify "npm run build"

ai repository list
ai repository show <id>

ai task create \
  --repo <id> \
  --title "Add user avatar" \
  --description "Allow users to upload avatars." \
  --accept "JPG supported" \
  --accept "Tests pass"
ai task validate <id>
ai task list [--repo <id>] [--status READY]
ai task show <id>
```

`DATABASE_URL` overrides `config/config.yaml`; `AI_STORAGE=memory` bypasses the
database entirely.

## Layout

```text
src/
  cli/          # ai CLI and command handlers
  config/       # yaml/env configuration
  db/           # postgres pool
  domain/       # domain models and validation
  store/        # RepositoryStore + TaskStore: in-memory + postgres
  util/         # ids, slugs
config/         # config/config.yaml
migrations/     # SQL schema (001_init.sql: 5 core tables)
scripts/        # db:migrate runner
tests/          # vitest unit tests
docs/           # v0.1 plan
```
