# Phase 12 Acceptance（TASK-1208 Release Gate 设计稿）

> 状态：**设计阶段**（2026-09-20），尚未实现。
> 前置：TASK-1201–1207 已完成并通过逐任务评审。
> 本任务的职责不是新增功能，而是回答一个问题：

> **1201–1207 组成的 Engineering Delivery Loop，能否作为以后每次改代码都重复运行的
> 通用验收基线？**

## 0. 原则

```text
Existing capability  →  Generic acceptance  →  Regression baseline  →  Release Gate

❌ 不新增生产能力（无新 Command / 状态 / 领域对象 / Scheduler 或 Worker 改动）
❌ 不绑定任何具体业务项目（继续用 tests/fixtures/sample-project/）
✅ 一条命令可重复运行全部 gate
✅ gate 不允许"跳过即通过"
✅ 代码状态 = 数据库状态 = 真实资源状态
```

## 1. Acceptance Matrix（先定死，再实现）

“来源”列区分 1208 复用既有覆盖 还是 1208 新增覆盖。

| ID | 场景 | 预期事实 | 来源 |
| --- | --- | --- | --- |
| A1 | Problem → Confirmation | 输入→分析→clarification→answer→`CONFIRMED`；重复消息只一个 Problem | 复用 `tests/e2e/phase11/problem-confirmation.test.ts` |
| A2 | Specification | `DRAFT→READY`；READY 需 acceptance + target；DRAFT-only 编辑 | 复用 `tests/specification.test.ts` |
| A3 | Planning | READY→N Tasks（INBOX）→`PLANNED`；重复 plan 不产生第二批；Delivery 自动建立 | 复用 `tests/e2e/phase12/specification-planning.test.ts` |
| A4 | Dependency DAG | 自依赖/重复边/环被拒；可跨 Specification；只有 `DONE` 满足依赖 | 复用 `tests/taskDependency*.test.ts` |
| A5 | Scheduling | 只调度 READY + runnable + 未被占用；阻塞不占并发额度；并发 scheduler 只 1 个 Run | 复用 `tests/scheduler.test.ts` + `tests/postgres.integration.test.ts` |
| A6 | Run / Workspace | 每个 attempt / 每个 target 新 Workspace；失败 attempt 清理；成功保留（Review 需要） | 复用 `tests/workerRetry.test.ts` |
| A7 | Verification | 逐 target 通过/失败 + evidence 落盘（command/exit/output） | 复用 `tests/workerMultiTarget.test.ts`、`tests/failureEvidence.test.ts` |
| A8 | Review / Approval | `REVIEW→DONE`（approve）/ `REVIEW→READY`（request changes）+ 审计 | 复用 `tests/e2e/phase11/review.test.ts`、`tests/e2e/phase12/delivery-loop.test.ts` |
| A9 | Delivery aggregation | 只算 required；PLANNED / IN_PROGRESS / READY_FOR_RELEASE / BLOCKED；每次读取重算 | 复用 `tests/delivery.test.ts` |
| A10 | Failure / Retry / Recovery | attempts 用尽→Task `BLOCKED`；下游 `dependency-blocked`；人工 reset→新 Run/新 Workspace；LOST/TIMEOUT/CANCEL 清理 | 复用 `tests/e2e/phase12/failure-recovery.test.ts`、`tests/workerRetry.test.ts` |
| A11 | Delivery recovery + Notification | `BLOCKED→IN_PROGRESS→READY_FOR_RELEASE`；通知只在 READY_FOR_RELEASE/BLOCKED；通知失败不回滚状态 | 复用 `tests/e2e/phase12/failure-recovery.test.ts`、`tests/deliveryReconciliation.test.ts` |
| A12 | Human Release boundary | 未 release 前 `releases = 0` 且状态停在 `READY_FOR_RELEASE`；release 幂等；`RELEASED` 不被覆盖 | 复用 `tests/delivery.test.ts`、`tests/e2e/phase12/delivery-release.test.ts` |
| A13 | Resource consistency | `executions` 终态 = `CLEANED`；无容器/网络/worktree 残留；无孤立 Workspace | **部分新增**（见 §4） |
| A14 | 单仓库回归 | Phase 1–10 路径行为不变（`--repo` 单值、旧 Verification 语义） | 复用 `tests/realE2E.integration.test.ts`、`tests/cliOutput.test.ts` |
| A15 | 全链路一次跑完 | 一条命令覆盖 A1–A12 的关键事实，最终停在人类 Release 边界 | **新增**（见 §2） |

## 2. 新增产物

```text
tests/e2e/phase12/acceptance.test.ts   # A15：一次运行走完整链路（内存/进程内、确定性）
scripts/verify-phase12.mjs             # gate runner：一条命令 + 隔离 DB + 汇总表
tests/helpers/testDatabases.ts         # 每套 DB 测试各自的 URL 解析 + 重复 DB 守卫
docs/phase12-acceptance.md             # 本文件（含最终结果记录）
package.json                           # 新增 npm run test:gate:phase12
```

A15 的验收路径（与 1201–1207 一致，仍在人类边界收口）：

```text
Problem → Confirmation → Specification(READY) → Planning(N Tasks, PLANNED)
  → Task DAG（B 依赖 A）→ Scheduler（先 A）
  → Run / Workspace → Verification（先失败）
  → Task BLOCKED → Delivery BLOCKED + blocked 通知
  → 人工 reset → 新 Run / 新 Workspace → Verification PASS
  → Review → approve → DONE → B runnable → DONE
  → Delivery READY_FOR_RELEASE + 通知
  → assertions: releases = 0；Delivery.status = READY_FOR_RELEASE
```

它与既有 5 个 phase12 文件的区别：那些文件各自聚焦一个关注点；A15 是
“读这一个文件就能看到完整交付链”的验收入口，断言矩阵 A1–A12 的关键事实。

## 3. 测试隔离（把已知的基建缺陷一并解决）

现状：`tests/postgres.integration.test.ts` 与 `tests/realE2E.integration.test.ts`
都读 `DATABASE_URL` 并在 `afterEach` 清表 → 同时运行会互相清表（各自单独跑都通过）。
“全部 gate 同时跑”因此目前不是可靠的 Release Gate。

### 决策 D1（建议采纳）：每个 DB 测试用自己的数据库

```text
tests/helpers/testDatabases.ts
  integrationDbUrl()  ← AI_TEST_DB_URL_INTEGRATION  ?? DATABASE_URL   （key: "integration"）
  realE2eDbUrl()      ← AI_TEST_DB_URL_REAL         ?? DATABASE_URL   （key: "real")
  assertDistinctDatabases()：两者相同则 console.warn（提示手动运行不支持并发）
```

- 不设新变量时行为与今天**完全一致**（单套手动运行不受影响）。
- gate runner 负责创建并迁移两个库，再分别注入上面两个变量：

```text
base URL：AI_TEST_DB_BASE ?? DATABASE_URL
派生库名：<base-db>_it   /   <base-db>_real
步骤：CREATE DATABASE（不存在时）→ 应用 migrations/*.sql → 注入环境变量
```

被否决的替代方案（记录理由，避免反复讨论）：

```text
schema-per-suite：需要给所有 SQL 加 search_path 或 schema 前缀，改动面大且易漏
串行执行（vitest sequence）：只解决"本机同时跑"，换机器/换 CI 仍会踩，且 gate 变慢
```

### 决策 D2（建议采纳）：gate 不允许“跳过即通过”

```text
AI_TEST_REQUIRE_DB=1 时，DB 测试在缺少开关/连不上库时 **直接失败**（不再 skip）
gate runner 始终设置该变量，并在运行前 preflight 检查：
  - DATABASE_URL 可达
  - 目标库存在且已迁移
  - real codex gate：AI_TEST_CODEX=1 且 codex 可执行
任一 preflight 失败 → gate FAIL（而不是静默 skip）
```

## 4. 真机资源核对（A13）

与 Phase 9/10 相同的判定口径：**数据库状态 = 真实资源状态**。

```text
检查项（gate 结束前 + 结束后各一次，对比基线）
1. docker ps -a --filter label=ai-harness.run-id        → 空
2. docker network ls | grep '^ai-net-'                  → 空（per-run 网络）
3. 每个 fixture 仓库 git worktree list                  → 只有主 worktree
4. workspace 根目录下无 run 残留目录
5. Postgres：终态 Run 对应的 executions 全部 CLEANED；无 active 状态但没有 lease 的 Run
6. Postgres：workspaces 行与磁盘目录一致（要么目录在、要么已清理并留下证据）
7. 宿主基线对比：docker ps/images/networks 数量在 gate 前后一致（允许镜像已存在）
```

运行位置：

```text
本机（macOS + 本地 Postgres）        → gate 1–6（typecheck / unit / PG / real codex）
Linux + Docker 主机（<验收主机>）→ Docker gate + A13 资源核对
                                        （沿用 docs/phase9-acceptance.md 的部署方式）
```

若本次没有 Docker 主机可用：gate 报告中 Docker gate 记为
`SKIPPED (no docker host)`，并且 **Phase 12 不允许因此宣布 FROZEN** ——
与 TASK-1012 的做法一致，真机资源核对必须至少跑过一次并留档。

## 5. Gate 清单与命令

```bash
npm run typecheck                 # 类型
npm test                          # 单元 + 内存 E2E（离线、无外部依赖）
npm run test:postgres             # DB gate #1（隔离库）
npm run test:e2e:real             # DB gate #2 + 真实 codex（隔离库）
npm run test:gate:phase12         # 一条命令跑完上面全部 + 汇总 + 资源核对

# Linux + Docker 主机（可选 gate，但 FROZEN 前必须至少通过一次）
AI_TEST_DOCKER=1 AI_EXECUTION_IMAGE=harness/execution:node22 npm run test:docker
```

`test:gate:phase12` 的输出格式（也作为最终记录写进本文件）：

```text
Phase 12 Release Gate — <date> <host>
  typecheck            PASS
  unit + in-memory E2E PASS  (N passed / M skipped)
  postgres integration PASS  (db: ai_harness_it,  13 tests)
  real codex E2E       PASS  (db: ai_harness_real, 1 test)
  resource checks      PASS  (containers/networks/worktrees/workspaces/executions)
  docker gate          SKIPPED (no docker host) | PASS (12 passed / 1 skipped)
=> PHASE 12 FROZEN
```

## 6. 实施顺序

```text
Step 1  测试隔离基础设施：testDatabases.ts + 两个 DB suite 改用各自 URL
        + AI_TEST_REQUIRE_DB 守卫（只动测试基建，不动生产代码）
Step 2  A15 验收测试：tests/e2e/phase12/acceptance.test.ts
Step 3  gate runner：scripts/verify-phase12.mjs + npm script（preflight/隔离/汇总/资源核对）
Step 4  本地跑 gate 1–6，记录结果
Step 5  Linux + Docker 主机跑 docker gate + A13，记录结果
Step 6  把结果与 PHASE 12 FROZEN 写进本文件；如有发现则回到对应 TASK 修复
```

每步完成标准：`npm run typecheck` ✅、`npm test` ✅、Postgres 集成 ✅（隔离库）、
real codex E2E ✅（隔离库）。

## 7. 明确不做

```text
❌ 新生产能力（Command / 状态 / 领域对象 / Scheduler / Worker / Loop 改动）
❌ GitHub / PR / Merge / Push / Deploy / CI-CD（外部交付集成留给后续阶段）
❌ 真实 Feishu/DingTalk/Slack 发送（部署环境验证，另立任务）
❌ CI 服务配置（GitHub Actions 等属于基础设施决策，不在本 gate）
❌ 把 gate 做成"永远绿"（跳过即失败；缺 Docker 主机就如实记录 SKIPPED）
```

## 8. 需要确认的决策

```text
D1  测试隔离用"每套 suite 独立数据库 + gate 创建/迁移"（替代方案见 §3）
D2  gate 设置 AI_TEST_REQUIRE_DB=1：缺库/缺凭证直接 FAIL，不再静默 skip
D3  新增 A15 全链路验收测试（tests/e2e/phase12/acceptance.test.ts）作为验收入口
D4  Docker/真机资源核对必须在 Linux 主机至少通过一次才允许 PHASE 12 FROZEN；
    无主机时如实记录 SKIPPED，不宣布 FROZEN
```
