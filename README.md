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
  MVP chain is complete and sealed: real PostgreSQL + real Codex end-to-end
  passes via `npm run test:e2e:real`.
- v0.2 (Review & Human Approval): reviewer agent over a succeeded run's diff +
  `task approve/reject` — done. Next per plan: Multi Repository Task,
  Dependency DAG, GitHub Integration.
- v0.2 P1 (Problem Confirmation, in progress): `problems` /
  `problem_analyses` / `clarifications` / `clarification_answers` schema +
  domain model + in-memory/Postgres stores, Problem Analyzer, Confirmation
  Loop, `problem.*` events and Problem -> Task conversion — done. Next:
  automated Investigation/Specification, then Multi Repository Task.
- v0.1 wrap-up: full event history (TaskCreated -> TaskDone) written by the
  validate/scheduler/worker/loop/review/approval paths, browsable via
  `ai event list` — done.
- v0.1 wrap-up: verified against a real PostgreSQL 16 instance (migrations +
  repository/task/run/event stores + full Loop end to end). The unit suite
  stays offline; the Postgres test runs with `AI_TEST_POSTGRES=1`.
- Phase 9 (Remote Execution & Isolation, in progress): ExecutionProfile /
  Policy / SecretStore / ExecutionManager + Docker 隔离参数规则、Repository
  executionProfile 绑定与 Worker 接入（ExecutionContext + 生命周期清理）
  已实现并有单测；Execution 生命周期契约（CREATING→RUNNING→CLEANED、
  cleanup obligation、`executions` 持久化、timeout/cancel、Worker 崩溃后
  Loop 回收、CLEANUP_FAILED 重试）已完成；Execution Image/Entry Contract、
  `ExecutionDriver.exec()`（`docker exec`）与 Codex/Verifier 的容器内执行
  通路已完成；真 Docker E2E 待做（本机无 Docker），见
  [docs/remote-execution-isolation.md](docs/remote-execution-isolation.md)。

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

# real Codex CLI end-to-end (requires: codex login)
npm run demo:codex

npm run db:migrate       # apply migrations/ against Postgres

# real-Postgres integration test (skipped by the plain unit suite)
AI_TEST_POSTGRES=1 DATABASE_URL=postgres://ai:ai@localhost:5432/ai_harness \
  npm run test:postgres

# v0.1 seal: real PostgreSQL + real Codex, full loop end to end
DATABASE_URL=postgres://ai:ai@localhost:5432/ai_harness npm run test:e2e:real
```

## Usage

```bash
ai repository create \
  --name my-app \
  --url git@github.com:example/my-app.git \
  --verify "npm run lint" \
  --verify "npm test" \
  --verify "npm run build" \
  --exec-image harness/node:22 \
  --network restricted --allow registry.npmjs.org \
  --secret GITHUB_TOKEN \
  --cpus 2 --memory-mb 4096 --pids-limit 512

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

# v0.2 P1: problem confirmation loop (AI analyzes, human confirms)
ai problem create --title "首页加载很慢" --statement "用户反馈加载慢" [--repo <id>]
ai problem analyze <problem-id>          # creates structured clarifications
ai problem answer <problem-id> <clarification-id> --option <option-id>
ai problem answer <problem-id> <clarification-id> --text "其他说明"
ai problem confirm <problem-id> [--problem ... --expected ... --scope ...]
ai problem task <problem-id> --repo <id> # CONFIRMED -> executable Task
ai problem list [--status NEEDS_INPUT] / ai problem show <problem-id>

# v0.2: review a succeeded run, then approve or reject the task
ai review <run-id>
ai task approve <task-id> [--note "..."]
ai task reject <task-id> [--feedback "..."]

# event history (all state changes)
ai event list [--task <id>] [--run <id>] [--type <type>] [--limit <n>]

# run the reconcile loop (single tick or resident; Ctrl-C to stop)
ai loop --once
ai loop --interval-ms 1000

# remove worktrees of finished runs (evidence in run result stays in DB)
ai workspace cleanup
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
migrations/     # SQL schema (001 core, 002 problem confirmation)
scripts/        # db:migrate runner
tests/          # vitest unit tests
docs/           # v0.1 plan, v0.2 roadmap, phase 9 isolation, discussion notes
docker/         # execution image contract + Dockerfile template
```
