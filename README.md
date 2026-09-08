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
- Phase 4 (Codex Adapter): `AgentEngine` + `CodexEngine` + Context Builder +
  manual `ai run <task-id>` — done (verified with a stub engine; real `codex
  exec` is wired with `--sandbox workspace-write`).
- Phase 5 (Verification): commands run per check in the run workspace; a run
  succeeds only when every check passes — done.
- Phase 6 (Worker): claim/heartbeat/execute/complete with run leases — done.
- Phase 7 (Scheduler): READY tasks -> QUEUED runs with max_concurrency — done.
- Phase 8 (Loop): Observe/Reconcile/Schedule/Execute/Recover — done. The v0.1
  MVP chain is complete; real-codex end-to-end runs still need a machine with
  the codex CLI.
- v0.2 (Review & Human Approval): reviewer agent over a succeeded run's diff +
  `task approve/reject` — done. Next per plan: Multi Repository Task,
  Dependency DAG, GitHub Integration.
- v0.1 wrap-up: full event history (TaskCreated -> TaskDone) written by the
  validate/scheduler/worker/loop/review/approval paths, browsable via
  `ai event list` — done.
- v0.1 wrap-up: verified against a real PostgreSQL 16 instance (migrations +
  repository/task/run/event stores + full Loop end to end). The unit suite
  stays offline; the Postgres test runs with `AI_TEST_POSTGRES=1`.

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
npm run demo:run         # Phase 4 acceptance demo (stub agent)
npm run demo:worker      # Phase 6 acceptance demo (worker + leases)
npm run demo:loop        # Phase 7/8 acceptance demo (scheduler + loop)
npm run demo:review      # v0.2 acceptance demo (review + approval)

npm run db:migrate       # apply migrations/ against Postgres

# real-Postgres integration test (skipped by the plain unit suite)
AI_TEST_POSTGRES=1 DATABASE_URL=postgres://ai:ai@localhost:5432/ai_harness \
  npm run test:postgres
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

# manual run (requires a registered repository whose local_path is a git
# checkout and the `codex` CLI; prompts are sent on stdin)
ai run <task-id>

# v0.2: review a succeeded run, then approve or reject the task
ai review <run-id>
ai task approve <task-id> [--note "..."]
ai task reject <task-id> [--feedback "..."]

# event history (all state changes)
ai event list [--task <id>] [--run <id>] [--type <type>] [--limit <n>]
```

`ai run` defaults: `codex exec --sandbox workspace-write --json -`, cwd = the
run workspace. Override the binary with `AI_CODEX_BIN`, the sandbox with
`AI_CODEX_SANDBOX`, and the workspaces base dir with `AI_WORKSPACES_DIR`.

`DATABASE_URL` overrides `config/config.yaml`; `AI_STORAGE=memory` bypasses the
database entirely.

## Layout

```text
src/
  agent/        # AgentEngine abstraction + CodexEngine + Context Builder
  cli/          # ai CLI and command handlers
  config/       # yaml/env configuration
  db/           # postgres pool
  domain/       # domain models and validation
  loop/         # periodic reconcile loop (observe/schedule/recover)
  scheduler/    # READY task scheduling with max_concurrency
  store/        # repository/task/run stores: in-memory + postgres
  util/         # ids, slugs
  verification/ # per-command verification runner
  worker/       # run executor with leases and heartbeats
  workspace/    # git-worktree workspace isolation (one run = one worktree)
config/         # config/config.yaml
migrations/     # SQL schema (001_init.sql: 5 core tables)
scripts/        # db:migrate runner
tests/          # vitest unit tests
docs/           # v0.1 plan
```
