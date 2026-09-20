# Phase 12 Acceptance — TASK-1208 Generic E2E / Release Gate（正式设计稿）

> 状态：**设计定稿（FROZEN DESIGN）**，实现待开始。
> 前置：TASK-1201–1207 已完成并通过逐任务评审。
> 本文件是 Phase 12 **唯一**的 Acceptance / Release Gate 文档。
> 实现完成后，本文件追加"Release Gate Result"章节（含 commit / host / date）。

## 1. Task Definition

TASK-1208 是 Phase 12 的最终验收任务。它不增加生产能力，而是把
TASK-1201–1207 已实现的能力固化成一套可重复执行、结果可审计、不会因为环境
隐式 Skip 而误判通过的验收体系：

```text
TASK-1201 ~ TASK-1207
        ↓
Existing Capabilities
        ↓
TASK-1208（Generic Acceptance → PostgreSQL Gate → Phase 12 E2E →
           Real Codex Gate → Docker/Resource Gate → Regression Gate）
        ↓
Release Gate
        ↓
PASS（连续三次）
        ↓
PHASE 12 FROZEN
```

### 1.1 Non-Goals（明确不做）

```text
❌ 新 Task / Run / Delivery 状态          ❌ 新 Scheduler / Retry / Recovery 策略
❌ 新 Dependency / Notification 模型       ❌ task.ready Command
❌ GitHub / GitLab / PR / Merge / Push      ❌ Deploy / CI-CD / Auto Release / Rollback
❌ Web Console / 新 Channel / 新 Agent      ❌ 真实 Feishu/DingTalk/Slack 发送
❌ CI 服务配置（GitHub Actions 等基础设施决策不在本任务）

TASK-1208 = Acceptance / Infrastructure / Regression
TASK-1208 ≠ Feature Development
```

## 2. 测试结构（不建立第二套平行 E2E）

Phase 12 现有 E2E（继续复用，不重命名、不重写）：

```text
tests/e2e/phase12/
├── specification-planning.test.ts    # A2/A3 Specification + Planning
├── task-dependency.test.ts           # A4 DAG（含环/自依赖/跨 Specification）
├── scheduler-dependency.test.ts      # A5 DAG-aware 调度 + 并发
├── delivery-release.test.ts          # A9/A12 Delivery + Release
├── delivery-loop.test.ts             # A8/A11 Loop reconciliation + 通知
└── failure-recovery.test.ts          # A10/A11 失败 → BLOCKED → 恢复

复用（Phase 11，不改动）：
tests/e2e/phase11/                    # A1 Problem/Confirmation、A8 Review
```

TASK-1208 **只新增**：

```text
tests/e2e/phase12/acceptance.test.ts  # Phase 12 全链路 Acceptance Entry Point
```

职责区分：

```text
existing tests        →  detailed regression（各自关注点）
acceptance.test.ts    →  cross-phase acceptance（关键阶段串成完整交付链）
```

命名统一 `*.test.ts`（vitest 默认同时匹配 test/spec；仓库既有约定为 `.test.ts`）。

## 3. 文档结构

```text
✅ docs/phase12-acceptance.md        ← 本文件（唯一）
❌ docs/acceptance/**                ← 不新增
```

本文件包含：Acceptance Matrix、Gate Definition、PASS/FAIL/SKIPPED Policy、
PostgreSQL 隔离、Real Codex、Docker 资源检查、命令、结果格式、FROZEN 条件、
Operator Boundary、Regression Boundary。

## 4. Fixtures

Phase 12 有两个**合法且职责不同**的 fixture，不为了统一而重写既有测试：

```text
tests/fixtures/sample-project/            → Generic Phase 12 Acceptance
synthetic git repo + checks.sh            → Real Codex E2E（tests/realE2E.integration.test.ts）
```

`sample-project` 约束：业务无关、无外部服务、无 API Key、**无第三方 npm 依赖**、
可离线执行、可重复初始化、可作为 Agent 的 Workspace。

### 4.1 Verification Fixture 扩展（TASK-1208 新增）

现状（`tests/fixtures/sample-project/package.json`）：只有 `verify` 一个 script。
1208 增加零依赖多 checks，用于验证「一个 Run 聚合多条 verification check 与
Evidence」：

```text
tests/fixtures/sample-project/
├── package.json        # scripts: lint / verify / build（全部 node 内置能力）
├── src/index.js
├── test/verify.js
├── scripts/lint.js     ← 新增
├── scripts/build.js    ← 新增
├── AGENTS.md
└── README.md
```

目标不是模拟真实 lint 工具，而是产生：

```text
check1 PASS + check2 PASS + check3 PASS  → Verification PASS  → Evidence
check1 PASS + check2 FAIL + check3 PASS  → Verification FAIL  → Failure Evidence
```

## 5. Acceptance 主链路

`acceptance.test.ts` 必须覆盖一条完整成功链路：

```text
Problem → Confirmation → Specification → Planning → Tasks → Dependency DAG
  → READY → Scheduler → Run → Workspace → Agent → Verification
  → REVIEW → Human Approval → DONE → Delivery → READY_FOR_RELEASE
  → Human Release → RELEASED
```

其中 `Human Approval`、`Human Release` 必须保持人工边界，**不得由 Loop 自动完成**。

## 6. Operator Boundary（必须显式记录，不得伪装成产品流程）

当前系统**没有** `task.ready` Command（TASK-1208 不新增）。因此 E2E 中以下两处
直接改 Task 状态的操作，明确标记为 **operator boundary**：

```text
Operator Boundary #1   Planning → Task INBOX → operator 置 READY
Operator Boundary #2   Task BLOCKED → operator reset → READY
```

除此之外，测试禁止为了方便直接 `INSERT Run` / `INSERT Release` /
`UPDATE Delivery` / `UPDATE Problem` 来伪造被测试流程；必须通过
Command / Application Service / Scheduler / Loop / Worker 等正式入口驱动。

## 7. Acceptance Matrix（Phase 12 长期回归入口）

| Area | Scenario | Expected | 覆盖位置 |
| --- | --- | --- | --- |
| Problem | create | Problem created + Conversation 关联 + 重复 command 不重复建 | phase11 + acceptance |
| Problem | clarification | NEEDS_INPUT | phase11 + acceptance |
| Problem | answer | CONFIRMED（跨 Problem 拒绝、重复幂等、free-text 持久化） | phase11 + acceptance |
| Specification | create | DRAFT（Problem != CONFIRMED → rejected(problem_not_confirmed)） | specification.test + acceptance |
| Specification | ready | READY（不完整 → rejected(specification_incomplete)） | specification.test + acceptance |
| Planning | plan | 1 Specification → N Tasks（INBOX，继承 targets/acceptance，Delivery 自动建） | phase12 specification-planning |
| Planning | replay | no duplicate + replayed 结果 | phase12 specification-planning |
| DAG | dependency | edge created（含跨 Specification） | phase12 task-dependency |
| DAG | cycle | direct / transitive / self 被拒 | phase12 task-dependency |
| Scheduler | runnable | Run created | phase12 scheduler-dependency |
| Scheduler | blocked | no Run（阻塞不占并发额度） | phase12 scheduler-dependency |
| Run | success | REVIEW | phase12 delivery-loop / acceptance |
| Run | retry | workspace 独立（workspace-1 ≠ workspace-2） | workerRetry / acceptance |
| Verification | multiple checks | 多 check 聚合（lint/verify/build） | **TASK-1208 新增**（fixture + acceptance） |
| Verification | failure | FAILED + Failure Evidence（check/exit/output，非 LLM 推断） | workerRetry / acceptance |
| Review | approve | DONE（reviewer + timestamp + event） | phase11 + acceptance |
| Review | changes | READY（不直接创建 Run，由 Loop/Scheduler 产生） | phase11 |
| Delivery | all required DONE | READY_FOR_RELEASE | delivery.test + acceptance |
| Delivery | failed required | BLOCKED | delivery.test + acceptance |
| Delivery | dependency blocked | BLOCKED（required 下游被 dependency-blocked） | delivery.test + acceptance |
| Retry | failure | fresh Workspace + 失败 Workspace 清理 | workerRetry |
| Recovery | LOST | recovered（不断言新 Run 中间状态） | workerRetry / workerRecoveryMulti |
| Cancel | queued | CANCELLED（同步） | phase11 cancel |
| Cancel | active | cancel request 持久化 → Worker/Loop 消费 | phase11 cancel |
| Cancel | terminal | rejected(run_not_cancellable) | phase11 cancel |
| Notification | ready | delivery.ready_for_release → notified | delivery-loop |
| Notification | blocked | delivery.blocked → notified（含 chain + evidence） | failure-recovery |
| Notification | failure | 状态不回滚 + pending retry + FIFO + capacity + maxPerPass | deliveryReconciliation |
| Release | ready | Release created（Delivery → RELEASED） | delivery-release |
| Release | repeat | idempotent（one Release record，created=false） | delivery-release |
| Release | Loop | no auto release（tick×3 后仍 READY_FOR_RELEASE，releases=0） | delivery-loop / acceptance |
| PostgreSQL | integration | PASS（独立库） | Gate 3 |
| Docker | cleanup | PASS（Gate 6，至少成功一次） | Gate 6 |
| Real Codex | execution | PASS / 允许 SKIPPED（有原因记录） | Gate 5 |

## 8. Release Gate Definition

```text
Gate 1  Typecheck
Gate 2  Unit + Memory E2E        （排除 **/*.integration.test.ts）
Gate 3  PostgreSQL Integration   （独立库 + AI_TEST_REQUIRE_DB=1）
Gate 4  Phase 12 E2E             （tests/e2e/phase12）
Gate 5  Real Codex E2E           （独立库 + AI_TEST_CODEX=1）
Gate 6  Docker / Workspace / Execution Resource
```

Gate 之间**串行执行**（Docker/Git/Workspace 重、宿主负载高时默认并发=4 会不稳；
必要时 `--no-file-parallelism`）。

命令：

```bash
# Gate 1
npm run typecheck

# Gate 2
npx vitest run --exclude '**/*.integration.test.ts'

# Gate 3
AI_TEST_REQUIRE_DB=1 npx vitest run tests/postgres.integration.test.ts

# Gate 4
npx vitest run tests/e2e/phase12

# Gate 5
AI_TEST_REQUIRE_DB=1 AI_TEST_CODEX=1 npx vitest run tests/realE2E.integration.test.ts

# Gate 6（资源检查，见 §11）

# 全部（TASK-1208 实现）：一条命令跑完 Gate 1–6 + 汇总 + 资源核对
npm run test:release-gate
```

### 8.1 为什么 `npm test` 不能单独作为 Gate 2

现状证据：`tests/postgres.integration.test.ts` 与 `tests/realE2E.integration.test.ts`
都在默认收集范围内，但缺 env 开关时**自动 skip**（当前基线 `426 passed / 37 skipped`）。
因此 `npm test` 全绿时 DB 与 real codex 可能根本没跑。Gate 2 必须显式排除
`*.integration.test.ts`，DB 与 real codex 各自成为独立 Gate。

## 9. PASS / FAIL / SKIPPED Policy

| Gate | 允许 SKIPPED | 规则 |
| --- | --- | --- |
| Gate 1 Typecheck | ❌ | 必须 PASS |
| Gate 2 Unit / Memory E2E | ❌ | 必须 PASS |
| Gate 3 PostgreSQL | ❌ | 必须 PASS（缺库/缺凭证 → FAIL） |
| Gate 4 Phase 12 E2E | ❌ | 必须 PASS |
| Gate 5 Real Codex | ✅ | 无 Provider 时允许，必须记录 `reason = provider unavailable` |
| Gate 6 Docker / Resource | ✅ | 无 Docker 主机时允许，但 **Phase 12 FROZEN 前必须至少成功执行过一次** |

硬规则：

```text
AI_TEST_REQUIRE_DB != 1  → 允许 skip（本地手动运行场景）
AI_TEST_REQUIRE_DB == 1  → DB 不可用 = FAIL（不是 SKIPPED）
SKIPPED ≠ PASSED（报告中必须如实区分）
```

## 10. PostgreSQL 隔离（基础设施级验收项）

现状缺陷（证据）：两个 DB suite 都读 `DATABASE_URL`，都在 `afterEach` 里
`DELETE FROM ...` 同一批表 → 同时运行会互相清表。因此"全量 Gate"目前不可靠。

方案（D1）：**每套 suite 使用独立 database**，由 gate runner 创建并迁移。

```text
tests/helpers/testDatabases.ts
  integrationDbUrl()  ← AI_TEST_DB_URL_INTEGRATION ?? DATABASE_URL
  realE2eDbUrl()      ← AI_TEST_DB_URL_REAL         ?? DATABASE_URL
  assertDistinctDatabases()：相同则 warn（手动并发运行不受支持）

gate runner：
  base URL = AI_TEST_DB_BASE ?? DATABASE_URL
  派生库名 = <base-db>_it / <base-db>_real（例：ai_harness_test / ai_harness_e2e）
  步骤：CREATE DATABASE（不存在时）→ 应用 migrations/*.sql → 注入两个 env var
```

不设新变量时行为与今天完全一致（单套手动运行不受影响）。要求：

```text
Suite A + Suite B 可并行执行，互不删除 / truncate / 覆盖数据、互不影响 migration state
任意两个套件不得依赖"谁先跑"
```

被否决的替代方案（记录理由，避免反复讨论）：

```text
schema-per-suite：迁移文件无 schema 前缀、runner 无版本表 → 需给所有 SQL 加
                  search_path/前缀，改动面大且易漏
串行执行（vitest sequence）：只解决本机同时跑，换机器/CI 仍会踩，且 Gate 更慢
```

## 11. Resource Gates（A13 / Gate 6）

### 11.1 Docker（代码中的实际命名约定）

```bash
docker ps -a     --filter label=ai-harness.run-id --format '{{.Names}}'   # 期望 empty
docker network ls --filter name=ai-net-          --format '{{.Name}}'     # 期望 empty
docker ps -a     --filter name=ai-proxy-         --format '{{.Names}}'    # 期望 empty
```

（`label=ai-harness.run-id` 来自 `src/execution/dockerArgs.ts`；`ai-net-<runId>`
来自 `src/execution/manager.ts`；`ai-proxy-` 由 `multiRepoDockerAcceptance` 断言。）
另需确认：无 orphan container / orphan network，Run 与 Execution 状态一致，
无 `docker.sock` 或额外 host mount。

### 11.2 Workspace（区分 expected 与 unexpected）

```text
成功 Run（进入 REVIEW）  → Workspace 可以保留（Review 需要）＝ expected persistent
FAILED / TIMED_OUT / CANCELLED / LOST → Workspace 必须清理
Retry → workspace-1 ≠ workspace-2
```

因此**不能**断言 `workspace count == baseline`，只能断言"没有 unexpected leak"。

### 11.3 Execution

```text
terminal Run → terminal Execution（CLEANED）→ 无孤儿 container/network/workspace
```

### 11.4 运行位置

```text
本机（macOS + 本地 Postgres）         → Gate 1–5
Linux + Docker 主机                   → Gate 6（沿用 docs/phase9-acceptance.md 的部署方式）
```

## 12. Gate Runner（TASK-1208 实现）

```text
scripts/verify-phase12.mjs   →  npm run test:release-gate

preflight：
  - Node/仓库状态、目标 DB 可达、两个隔离库存在且已迁移
  - Gate 5：AI_TEST_CODEX=1 且 codex 可执行；缺失 → 记录 SKIPPED(reason)，
    但 **不得**因此让 Gate 5 显示 PASS
  - Gate 6：docker 可用性检测；不可用 → SKIPPED(reason)，并阻止 FROZEN
执行：Gate 1 → 6 串行；每个 Gate 独立进程、独立 JSON 结果
输出：控制台汇总表 + artifacts/phase12-release-gate.json
```

`artifacts/` 加入 `.gitignore`（artifact 不提交 Git）。

### 12.1 结果格式

每个 Gate 通过 vitest JSON reporter 取真实数字，禁止人工填写：

```bash
vitest run --reporter=json --outputFile=artifacts/<gate>.json
```

```json
{
  "phase": "12",
  "task": "TASK-1208",
  "commit": "<sha>",
  "host": "<host>",
  "date": "<timestamp>",
  "gates": {
    "typecheck": "PASS",
    "unit": "PASS",
    "postgres": "PASS",
    "phase12E2E": "PASS",
    "realCodex": "SKIPPED",
    "resources": "PASS"
  },
  "acceptance": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 },
  "status": "PASS"
}
```

`SKIPPED` 必须同时记录 `reason`。

### 12.2 连续三次

```text
Run #1 PASS → Run #2 PASS → Run #3 PASS
```

三次之间不得出现 FAIL（用于验证隔离、确定性、清理、并发）。

## 13. FROZEN Definition 与 Semantics

Phase 12 FROZEN 必须**同时**满足：

```text
1  TASK-1201 ~ 1207 完成
2  TASK-1208 Acceptance 完成
3  Gate 1 Typecheck PASS
4  Gate 2 Unit / Memory E2E PASS
5  Gate 3 PostgreSQL PASS
6  Gate 4 Phase 12 E2E PASS
7  Gate 6 Docker / Resource 至少成功执行过一次
8  连续三次 Release Gate PASS
9  所有 SKIPPED 项均有明确 reason
10 Acceptance Matrix（§7）全部覆盖
11 docs/phase12-acceptance.md 完成并含结果记录
```

```text
Docker 从未成功运行 → Phase 12 = NOT FROZEN
Real Codex 可 SKIPPED，但必须记录原因（不得显示 PASSED）
```

`PHASE 12 FROZEN` 的含义不是"永远不能改代码"，而是：

> TASK-1201–1207 定义的 Phase 12 生产语义已通过正式 Acceptance Gate；
> 后续修改不得在没有新 Task / 新验收的情况下改变这些语义。

```text
Frozen → bug 发现 → 新 Task → 修改 → 回归 → 新的 Release Gate（不得直接改完继续称 FROZEN）
```

## 14. Regression Boundary（实现期纪律）

```text
❌ 不修改：Scheduler / Worker / Loop / Delivery aggregation / Retry /
          Cancellation / Recovery / Dependency / Review / Release 语义
✅ 若现有语义与 Acceptance 不一致：先确认现有语义 → 更新 Acceptance（文档）
✅ 若确实需要改变语义：TASK-1208 STOP → 另立 feature/design task
```

## 15. 实现顺序（严格按此推进）

```text
Step 1  测试隔离基建
        tests/helpers/testDatabases.ts + 两个 DB suite 改用各自 URL
        + AI_TEST_REQUIRE_DB 守卫（只动测试基建，不动生产代码）
Step 2  Gate Runner
        scripts/verify-phase12.mjs + npm run test:release-gate
        （preflight / 隔离库创建与迁移 / 串行执行 / JSON 汇总 / 资源核对）
Step 3  acceptance.test.ts
        Phase 12 全链路 Acceptance Entry Point（主链路 + Matrix 关键事实）
Step 4  Fixture 多 check
        sample-project 增加 scripts/lint.js + scripts/build.js（零依赖）
        + 多 check 聚合 / 失败 evidence 的验收
Step 5  Resource Gate
        Gate 6 检查项落地（docker / workspace / execution）+ 基线对比
Step 6  连续三次 Gate + 结果落盘
        本机 Gate 1–5；Linux+Docker 主机 Gate 6；结果写入本文件；宣布 FROZEN
```

每一步的完成标准：`npm run typecheck` ✅、Gate 2 ✅、Gate 3（隔离库）✅、
Gate 5（real codex）✅。

## 16. 完成标准（Checklist）

```text
Test Structure  □ 不建第二套 E2E  □ 保留既有 phase12 测试  □ 新增 acceptance.test.ts
Fixture         □ sample-project 多 check  □ 零第三方依赖  □ 离线  □ realE2E fixture 不改
Isolation       □ 独立 database  □ AI_TEST_REQUIRE_DB=1  □ 缺库 FAIL  □ 两套可并行
Acceptance      □ Problem … Human Release 全链路（§5）  □ Matrix（§7）逐项覆盖
Resource        □ container/network/proxy/execution 清理  □ workspace 生命周期  □ retry 隔离
Gate            □ Gate1–6 定义落地  □ SKIPPED policy  □ JSON 结果  □ 连续三次 PASS
Documentation   □ 本文件含 Matrix/Policy/Operator Boundary/命令/结果/FROZEN 声明
```

## 17. Release Gate Result（实现后填写）

```text
（待 TASK-1208 实现完成后填写）
commit:
host:
date:
Gate 1 Typecheck:
Gate 2 Unit / Memory E2E:
Gate 3 PostgreSQL:
Gate 4 Phase 12 E2E:
Gate 5 Real Codex:
Gate 6 Docker / Resource:
连续三次（Run #1 / #2 / #3）:
结论: PHASE 12 FROZEN / NOT FROZEN
```
