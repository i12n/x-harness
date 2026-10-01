# ai-harness

> 路线状态：Phase 9 / 10 / 11 / 12 均已 **FROZEN**（v0.2 技术基线）。
> 盘点与债务：[docs/v0.2-milestone-review.md](docs/v0.2-milestone-review.md)；
> 基线：[docs/v0.2-baseline.md](docs/v0.2-baseline.md)；
> 真实环境验证（含真实 Codex 闭环）：[docs/v0.2-environment-validation.md](docs/v0.2-environment-validation.md)。

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
  通路已完成；并已在真机（Linux + Docker）完成 TASK-910 生命周期/隔离矩阵
  与 TASK-905 网络强制验收（12 passed / 1 skipped）—— **Phase 9 DONE**，见
  [docs/remote-execution-isolation.md](docs/remote-execution-isolation.md)。
  真机验收 runbook：[docs/phase9-acceptance.md](docs/phase9-acceptance.md)
  （`npm run test:docker` / `npm run test:docker:network`）。
- Phase 10 (Multi Repository Task): `Task.targets[]`（primary/supporting +
  baseRef）、per-target Workspace、Execution 多挂载、多仓库 Context、
  TargetVerifier、Worker/Run 聚合、异常恢复与 CLI/API —— 真机 Release Gate
  10/10 通过，**DONE**。设计见
  [docs/multi-repository-task.md](docs/multi-repository-task.md)。
- Phase 11 (Conversational Interface): Channel 抽象 + CliChannel、Conversation
  （会话/消息 + 幂等）、Feishu Provider/Event Ingestion（离线）、业务渲染器、
  Intent → Command（校验/授权/幂等/显式路由）、Problem Confirmation、
  Task/Run 操作（含持久化取消）、Review/Approval，以及通用 E2E 基线
  （`tests/e2e/phase11/`）—— **DONE**（真实 Feishu 凭证/公网回调留待部署
  联调）。设计见
  [docs/conversational-interface.md](docs/conversational-interface.md)。
- Phase 12 (Engineering Delivery Loop, in progress): Problem → Specification
  → Task → Dependency → Scheduler 的交付闭环。TASK-1201 Specification Model
  （领域模型 + 迁移 008 + store + application service）与 TASK-1202
  Specification → Task Planning（迁移 009 + `TaskPlanner` + `PlanningService`
  → N Tasks；`spec.show` / `spec.plan` Command 与 `ai spec show|plan`；
  幂等且不自动执行）、TASK-1203 Task Dependency / DAG（迁移 010 +
  `TaskDependencyService`：环检测、重复/自依赖防护、runnable 判定；
  Scheduler 未改动）、TASK-1204 Dependency-aware Scheduler（Scheduler 只消费
  runnable 查询，依赖不占并发额度；迁移 011 保证每 Task 至多一个 active Run）
  、TASK-1205 Delivery / Release Model（迁移 012：Delivery 按 required Task
  状态聚合、每次读取重算，Release 只是人工记录；`ai delivery show|release`）
  、TASK-1206 Delivery Reconciliation Loop（`Loop.tick()` 调度前后各做一次
  Delivery 聚合，只在 READY_FOR_RELEASE / BLOCKED 迁移时通过 DeliveryNotifier
  通知，绝不自动 release）、TASK-1207 Failure / Retry / Recovery Hardening
  （依赖失败影响与阻塞链、失败证据、Loop 阶段级错误隔离、有界 FIFO 通知队列、
  跨 Task 可见性、retry/workspace/并发回归 —— 仍由人工 Release 收口）
  已完成 —— 见
  [docs/engineering-delivery-loop.md](docs/engineering-delivery-loop.md)。
  Phase 12 的 Release Gate（TASK-1208）设计已定稿，见
  [docs/phase12-acceptance.md](docs/phase12-acceptance.md)
  （Acceptance Matrix / 6 Gates / 测试隔离 / 资源核对 / FROZEN 条件）。
- Phase 13 (main-chain entry & hardening, in progress): Phase 13 的 backlog
  见 [docs/v0.2-milestone-review.md](docs/v0.2-milestone-review.md) §4/§7。
  TASK-1210 Main-chain Entry Point 已完成：主链重新有生产入口 ——
  `spec.create`（CONFIRMED Problem → DRAFT）、`spec.update`（仅 DRAFT 可编辑）、
  `spec.ready`（DRAFT → READY）三个 Command 加入既有 `spec.show` / `spec.plan`
  目录，CLI 暴露为 `ai spec create|update|ready|show|plan`；命令层新增
  `string[]` 字段类型。旧路径 `ai problem task` 保留为**标记为 deprecated 的
  逃生口**（执行前打印警告），不再是未命名的第二入口。

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
ai problem task <problem-id> --repo <id> # [deprecated] escape hatch: CONFIRMED -> Task
ai problem list [--status NEEDS_INPUT] / ai problem show <problem-id>

# Phase 13 / TASK-1210: main chain Problem -> Specification -> Planning -> Task
ai spec create --problem <problem-id> \
  --accept "验收标准" --accept "又一条" \
  --repo <primary-repo-id> --repo <supporting-repo-id> [--title ...] [--summary ...]
ai spec update <spec-id> --accept "..." --repo <id>  # DRAFT only; READY/PLANNED are frozen
ai spec ready <spec-id>                              # DRAFT -> READY (needs acceptance + targets)
ai spec show <spec-id> / ai spec plan <spec-id>

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

## 部署 / 飞书机器人

`ai serve` 常驻进程 = 控制面（飞书长连接 → Conversation → Intent → Command）
+ 执行面（Scheduler / Worker / per-Run 容器 / Codex / 验证）。

```bash
cp deploy/ai-harness.env.example deploy/ai-harness.env   # 填凭证
deploy/deploy.sh          # 本机：typecheck + test + build + rsync + migrate
deploy/install.sh         # 真机：独立 PostgreSQL + 迁移 + systemd 单元
journalctl -u ai-harness -f
```

飞书侧走**长连接**（无需公网回调/域名/端口）；执行侧 Docker 驱动下容器即隔离
边界。**没有 Web 控制台**：所有配置都在聊天里完成——

```text
查看配置                          列出已设置项（密钥只显示「已设置」）
把最大并发改成 1                   任意非密钥项
设置 FEISHU_APP_SECRET hydU…      密钥：确定性格式，不经过模型、不入库
授权 ou_xxx 为 developer          白名单
重启服务                          使改动生效
```

完整步骤、配置项清单、授权白名单、注册被开发仓库与验收记录见
[docs/deployment-feishu.md](docs/deployment-feishu.md)。
真实部署主机与账号标识**不在仓库里**，见本地未提交文档 `docs/private/deployment-local.md`。

配置**只在聊天里改**（没有 Web 控制台）：`查看配置`、`把最大并发改成 1`、
`授权 ou_xxx 为 developer`、`设置 FEISHU_APP_SECRET …`、`重启服务`。
密钥走确定性路径，不经过模型、不写入会话记录。查询类还有 `当前有哪些仓库` /
`现在有几个任务` / `最近跑了什么` / `有哪些问题` / `聊天记录`。判定规则
（什么该建开发任务、什么只是查询，以及拿不准时先确认）见
[docs/intent-triage.md](docs/intent-triage.md)。

GitHub 仓库：`ai repository sync <id>` 取代码；开源推送用
`--git-push allow` 显式开启，之后**审批即推送**（只推 `ai/` 前缀分支，agent
容器不持有仓库凭证）。

## Layout

```text
src/
  agent/        # AgentEngine abstraction + CodexEngine + Context Builder
  channel/      # Channel abstraction, CLI adapter, Feishu provider/ingestion
  cli/          # ai CLI and command handlers
  command/      # intent → command: schema, authorization, idempotency, dispatch
  config/       # yaml/env configuration
  db/           # postgres pool
  domain/       # domain models and validation
  execution/    # ExecutionManager + local/docker drivers (Phase 9)
  loop/         # periodic reconcile loop (observe/schedule/recover)
  problem/      # problem confirmation loop + analyzer
  review/       # review/approval application service
  run/          # run + task-run application services
  scheduler/    # READY task scheduling with max_concurrency
  specification/# Specification domain/application (Phase 12)
  delivery/     # Delivery aggregation + release records (Phase 12)
  store/        # repository/task/run stores: in-memory + postgres
  task/         # task application services (dependency graph, Phase 12)
  util/         # ids, slugs
  verification/ # per-command verification runner
  worker/       # run executor with leases and heartbeats
  workspace/    # git-worktree workspace isolation (one run = one worktree)
  llm/          # OpenAI-compatible chat client for the control plane
  server/       # deployment composition: daemon, Feishu long connection,
                # chat session, notifications, specification bootstrap,
                # deployment/ (env file, config schema, query ports)
config/         # config/config.yaml
deploy/         # systemd unit, env template, PostgreSQL compose, deploy scripts
migrations/     # SQL schema (001 core ... 012 deliveries and releases)
scripts/        # db:migrate runner
tests/          # vitest unit tests
docs/           # v0.1 plan, v0.2 roadmap, phase 9 isolation/acceptance,
                # phase 10 multi-repository design, phase 11 conversational
                # interface design, phase 12 delivery loop, deployment runbook,
                # discussion notes
docker/         # execution image contract + Dockerfile + allow-list proxy
```
