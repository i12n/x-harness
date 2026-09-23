# Phase 12 Acceptance：TASK-1208 Generic E2E Acceptance / Release Gate（正式设计稿）

> 状态：**已实现并通过 Release Gate**（2026-09-23）→ **PHASE 12 FROZEN**。
> 验收记录见文末 §48（commit / host / 三次连跑 / 资源核对 / FROZEN 判定）。
> 前置：TASK-1201–TASK-1207 已完成并通过逐任务评审。
> 实现顺序：测试隔离基建 → Gate Runner → `acceptance.test.ts` → fixture 多 check →
> Resource Gate → 连续三次 Gate → FROZEN。

## 1. Task Definition

### 目标

TASK-1208 是 **Phase 12 的最终验收任务**。

它不增加新的生产能力，而是将 TASK-1201～TASK-1207 已经实现的能力组合成一套：

* Generic E2E Acceptance
* PostgreSQL Integration Gate
* Real Codex E2E Gate
* Docker / Resource Acceptance
* Regression Gate
* Release Gate
* Phase 12 Freeze Criteria

最终形成一个可以重复执行、结果可审计、不会因为测试环境隐式 Skip 而误判通过的验收体系。

核心关系：

```text
TASK-1201 ~ TASK-1207
        ↓
Existing Capabilities
        ↓
TASK-1208
        ↓
Generic Acceptance
        ↓
Release Gate
        ↓
PASS
        ↓
PHASE 12 FROZEN
```

## 2. Non-Goals

TASK-1208 不新增以下生产能力：

* 新 Task 状态
* 新 Run 状态
* 新 Scheduler 策略
* 新 Retry 策略
* 新 Recovery 机制
* 新 Dependency 模型
* 新 Delivery 状态
* 新 Notification 模型
* `task.ready` Command
* GitHub / GitLab Integration
* Pull Request
* Merge
* Push
* Deploy
* CI/CD
* Auto Release
* Rollback
* Web Console
* 新 Channel
* 新 Agent

特别是：

```text
TASK-1208 = Acceptance / Infrastructure / Regression

TASK-1208 != Feature Development
```

## 3. Existing Test Structure

不得建立第二套平行 Phase 12 E2E。

当前已有 Phase 12 E2E 必须继续复用：

```text
tests/e2e/phase12/
├── specification-planning.test.ts
├── task-dependency.test.ts
├── scheduler-dependency.test.ts
├── delivery-release.test.ts
├── delivery-loop.test.ts
└── failure-recovery.test.ts
```

实际文件名以仓库当前版本为准。

TASK-1208 只新增：

```text
tests/e2e/phase12/acceptance.test.ts
```

该文件不是重复实现所有测试，而是作为：

> Phase 12 全链路 Acceptance Entry Point

用于验证关键阶段能够串成完整交付链路。

因此：

```text
existing tests
    ↓
detailed regression

acceptance.test.ts
    ↓
cross-phase acceptance
```

两者职责不同。

## 4. Documentation Structure

只保留：

```text
docs/phase12-acceptance.md
```

不新增：

```text
docs/acceptance/
docs/acceptance/phase12-release-gate.md
```

`docs/phase12-acceptance.md` 是 Phase 12 唯一 Acceptance / Release Gate 文档。

其中合并：

* Acceptance Matrix
* Gate Definition
* PASS / FAIL / SKIPPED Policy
* PostgreSQL Isolation
* Real Codex
* Docker Resource Checks
* Test Commands
* Result Format
* FROZEN Criteria

## 5. Generic Test Fixture

Phase 12 Generic Acceptance 使用：

```text
tests/fixtures/sample-project/
```

该 Fixture 必须保持：

* 业务无关
* 无外部服务依赖
* 无 API Key
* 无 npm 第三方依赖
* 可以离线执行
* 可以重复初始化
* 可以作为 Agent 修改代码的 Workspace

## 6. Verification Fixture

当前 Fixture 只有：

```json
{
  "scripts": {
    "verify": "node test/verify.js"
  }
}
```

TASK-1208 增加零依赖 verification checks，用于验证：

> 一个 Run 可以正确聚合多个 verification check 的结果和 Evidence。

建议最终结构：

```text
tests/fixtures/sample-project/
├── package.json
├── src/
│   └── index.js
├── test/
│   └── verify.js
├── scripts/
│   ├── lint.js
│   └── build.js
├── AGENTS.md
└── README.md
```

例如：

```json
{
  "scripts": {
    "lint": "node scripts/lint.js",
    "verify": "node test/verify.js",
    "build": "node scripts/build.js"
  }
}
```

全部使用 Node 内置能力。

不得引入 ESLint、TypeScript、Jest 等额外 npm dependency。

目标不是模拟真实 lint 工具，而是验证：

```text
check 1 PASS
check 2 PASS
check 3 PASS
       ↓
Verification PASS
       ↓
Evidence
```

以及：

```text
check 1 PASS
check 2 FAIL
check 3 PASS
       ↓
Verification FAIL
       ↓
Failure Evidence
```

## 7. Real Codex Fixture

Real Codex E2E **不修改现有 fixture**。

继续使用：

```text
tests/realE2E.integration.test.ts
```

当前 synthetic git repository + `checks.sh` fixture。

它本身已经是：

```text
business-agnostic synthetic repository
```

不为了统一 Fixture 而重写已有 Real E2E。

因此 Phase 12 有两个合法的测试 Fixture：

```text
sample-project
    ↓
Generic Phase 12 Acceptance

synthetic git repo + checks.sh
    ↓
Real Codex E2E
```

二者职责不同。

## 8. Acceptance Main Flow

`acceptance.test.ts` 必须覆盖一条完整成功链路：

```text
Problem
  ↓
Confirmation
  ↓
Specification
  ↓
Planning
  ↓
Tasks
  ↓
Dependency DAG
  ↓
READY
  ↓
Scheduler
  ↓
Run
  ↓
Workspace
  ↓
Agent
  ↓
Verification
  ↓
REVIEW
  ↓
Human Approval
  ↓
DONE
  ↓
Delivery
  ↓
READY_FOR_RELEASE
  ↓
Human Release
  ↓
RELEASED
```

其中：

```text
Human Approval
Human Release
```

必须保持人工边界。

不得由 Loop 自动完成。

## 9. Problem / Confirmation Acceptance

验证 Problem：

```text
Problem.create
      ↓
Problem
      ↓
Conversation association
```

覆盖：

* Problem 创建成功
* Conversation 正确关联
* Duplicate command 不创建第二个 Problem
* Problem 状态正确

然后构造需要用户输入的场景：

```text
Problem
  ↓
ANALYZING
  ↓
NEEDS_INPUT
  ↓
Clarification
```

回答后：

```text
ANSWERED
  ↓
ANALYZING
  ↓
CONFIRMED
```

必须验证：

* Required clarification 阻止确认
* 正确回答后重新分析
* 跨 Problem 回答被拒绝
* 重复回答幂等
* Free-text answer 正常持久化

## 10. Specification Acceptance

从：

```text
Problem = CONFIRMED
```

创建：

```text
Specification = DRAFT
```

然后：

```text
markReady
    ↓
READY
```

验证：

* summary
* requirements
* constraints
* targets
* primary target
* acceptance

非法场景：

```text
Problem != CONFIRMED
```

必须：

```text
rejected(problem_not_confirmed)
```

Specification 不完整：

```text
markReady
    ↓
rejected(specification_incomplete)
```

## 11. Planning Acceptance

执行：

```text
Specification READY
       ↓
spec.plan
       ↓
Specification PLANNED
       ↓
Task 1
Task 2
...
```

验证：

* 一 Specification 可以产生多个 Task
* Task 正确继承 Specification 信息
* Task 初始状态 `INBOX`
* Plan item 正确持久化
* Delivery 自动创建
* 重复 planning 幂等
* 不重复创建 Task
* deterministic IDs 生效

必须保持：

```text
1 Specification → N Tasks
```

## 12. Operator Boundary

当前系统没有：

```text
task.ready
```

Command。

因此 Planning 后：

```text
Task
INBOX
```

需要进入：

```text
READY
```

的现有 E2E 测试允许通过 Store / 测试辅助入口直接修改状态。

该操作必须明确标记：

```text
operator boundary
```

而不是伪装成正式产品 Command。

同样，Failure / Recovery E2E 中：

```text
BLOCKED → READY
```

的人工 reset 也属于：

```text
operator boundary
```

原因：

> 系统当前尚无 `task.ready` Command。

TASK-1208 不新增该 Command。

## 13. Dependency DAG Acceptance

至少构造：

```text
Task A ─────┐
            ├──→ Task C
Task B ─────┘
```

验证：

```text
A DONE
B DONE
    ↓
C runnable
```

以及：

```text
A DONE
B FAILED
    ↓
C dependencyBlocked
```

还需要覆盖：

```text
A → B → C
```

验证：

```text
blockingTaskIds
blockingChain
```

例如：

```text
blockingTaskIds = [A]
blockingChain   = [A, B, C]
```

同时验证：

* self dependency rejected
* direct cycle rejected
* transitive cycle rejected
* duplicate edge idempotent
* dependency 不修改 Task state
* dependency 不创建 Run

## 14. Scheduler Acceptance

验证：

```text
READY + Runnable
       ↓
Run QUEUED
```

以及：

```text
READY + dependencyBlocked
       ↓
No Run
```

并覆盖：

* maxConcurrency
* active Run protection
* concurrent scheduler
* DB unique active Run constraint

最终保证：

```text
same Task
   ↓
at most one active Run
```

Scheduler 不直接：

* 查询 `task_dependencies`
* 做 DFS
* 创建 dependency edge
* 修改 Task status

Scheduler 只消费：

```text
RunnableTaskQuery
```

## 15. Run / Workspace Acceptance

每一个 Run 使用独立 Workspace。

验证：

```text
Run A → workspace-A
Run B → workspace-B
```

必须：

```text
workspace-A != workspace-B
```

Multi-target：

```text
Primary
  → /workspace

Supporting
  → /workspaces/<targetId>
```

验证：

* Primary 正确
* Supporting 正确
* Workdir 正确
* Retry 使用新 Workspace
* 不发生 Workspace contamination

## 16. Verification / Evidence Acceptance

使用多 verification checks：

```text
lint
test
build
```

验证：

```text
check A PASS
check B PASS
check C PASS
       ↓
Verification PASS
```

以及：

```text
check A PASS
check B FAIL
check C PASS
       ↓
Verification FAIL
```

Evidence 必须包含现有系统能够提供的事实：

* check name
* status
* exit code
* output
* failing check
* target
* Run

不得通过 LLM 推测 Failure。

## 17. Review / Approval Acceptance

成功 Run：

```text
Verification PASS
       ↓
Task REVIEW
```

验证：

```text
review.show
```

然后：

```text
review.approve
       ↓
Task DONE
```

另一条：

```text
review.request_changes
       ↓
Task READY
```

必须确认：

* reviewer 被记录
* timestamp 被记录
* event 被记录
* request changes 不直接创建 Run
* 下一次 Run 由 Loop / Scheduler 产生

## 18. Delivery Acceptance

Delivery 聚合 required Tasks。

成功：

```text
A DONE
B DONE
C DONE
   ↓
READY_FOR_RELEASE
```

失败：

```text
A DONE
B FAILED
   ↓
BLOCKED
```

Dependency blocked：

```text
B READY
B dependencyBlocked
   ↓
Delivery BLOCKED
```

必须验证：

* 只聚合 required Tasks
* required Task 未完成不能 Release
* Delivery status 根据当前 Task facts 重新计算
* RELEASED 不被后续 reconciliation 覆盖

## 19. Failure / Retry Acceptance

构造：

```text
Run #1
   ↓
Verification FAIL
   ↓
Task READY
   ↓
Run #2
```

验证：

```text
workspace-1 != workspace-2
```

失败 Workspace：

```text
Run #1
   ↓
cleanup
```

Retry：

```text
Run #2
   ↓
fresh Workspace
```

至少覆盖：

* FAILED retry
* TIMEOUT retry
* LOST recovery
* CANCELLED recovery
* retry concurrency
* active Run duplicate protection

## 20. Cancellation Semantics

必须按照当前实现验收，而不是引入新的“恢复”语义。

### QUEUED

```text
QUEUED
  ↓
cancel
  ↓
CANCELLED
  ↓
Task READY / BLOCKED
```

Cancellation：

> 消耗一次 attempt。

因此：

```text
attempt += 1
```

之后根据现有 retry policy：

```text
attempt < maxAttempts
    ↓
READY

attempt >= maxAttempts
    ↓
BLOCKED
```

### Active Run

```text
STARTING / RUNNING / VERIFYING
            ↓
      cancel request
            ↓
Worker / Loop
            ↓
        CANCELLED
```

不新增：

```text
CANCELLING
CANCEL_REQUESTED
```

Run status。

### Terminal Run

```text
terminal
   ↓
run.cancel
   ↓
rejected(run_not_cancellable)
```

## 21. LOST Recovery Semantics

Worker 消失：

```text
RUNNING
   ↓
reconciliation
   ↓
LOST
```

然后系统可以在同一次：

```text
Loop.tick()
```

中继续：

```text
cleanup
  ↓
Task recovery
  ↓
schedule
  ↓
execute
```

因此 E2E **不得断言新 Run 的中间状态**。

例如不得要求：

```text
new Run == QUEUED
```

只需要断言：

```text
old Run == LOST
```

以及：

```text
Task 任意时刻最多一个 active Run
```

最终如果重跑成功，则验证新的 Run 结果即可。

## 22. Delivery Notification Acceptance

只验证已有 notification semantics：

```text
READY_FOR_RELEASE
       ↓
delivery.ready_for_release
       ↓
notification
```

以及：

```text
BLOCKED
   ↓
delivery.blocked
   ↓
notification
```

必须验证：

* transition 不重复
* notification failure 不回滚 Delivery
* pending notification 可以 retry
* FIFO
* maxPerPass
* capacity
* overflow policy
* notification 不触发 Auto Release

## 23. Human Release Boundary

这是 Phase 12 的关键 Release Gate。

Loop：

```text
tick()
tick()
tick()
```

不能：

```text
READY_FOR_RELEASE
        ↓
RELEASED
```

必须保持：

```text
READY_FOR_RELEASE
        ↓
WAITING FOR HUMAN
```

只有：

```text
delivery.release
```

才能：

```text
READY_FOR_RELEASE
        ↓
RELEASED
```

重复 Release：

```text
delivery.release
delivery.release
```

必须得到：

```text
one Release record
created = false
```

## 24. PostgreSQL Isolation

当前：

```text
tests/postgres.integration.test.ts
tests/realE2E.integration.test.ts
```

不能共享会互相清理的测试数据库。

TASK-1208 使用：

```text
Independent PostgreSQL Database
```

推荐：

```text
ai_harness_test
ai_harness_e2e
```

例如：

```text
postgres.integration
        ↓
ai_harness_test

realE2E
        ↓
ai_harness_e2e
```

要求：

```text
Suite A
   +
Suite B
```

可以并行执行而不：

* 删除对方数据
* truncate 对方数据
* 修改对方 migration state
* 覆盖对方 fixture

## 25. AI_TEST_REQUIRE_DB

新增 / 固化：

```text
AI_TEST_REQUIRE_DB=1
```

语义：

```text
AI_TEST_REQUIRE_DB != 1
    ↓
环境允许 skip

AI_TEST_REQUIRE_DB=1
    ↓
DB unavailable
    ↓
FAIL
```

禁止：

```text
DB unavailable
    ↓
SKIPPED
    ↓
Release Gate PASS
```

PostgreSQL Gate 必须明确：

```text
PASS
```

才能通过。

## 26. Real Codex Gate

Real Codex Gate 使用：

```text
AI_TEST_REQUIRE_DB=1
AI_TEST_CODEX=1
```

并使用独立 E2E database。

要求：

```text
Generic synthetic repo
       ↓
Codex Engine
       ↓
Execution
       ↓
Verification
       ↓
Evidence
       ↓
Run result
```

不使用具体业务项目。

Real Codex 所需 Provider / API Key 由环境提供。

不得：

* hard-code API key
* 把 secret 提交到 repository
* 测试中伪造 PASS

## 27. SKIPPED Policy

最终 Policy 固定如下：

| Gate | SKIPPED | 规则 |
| --- | --- | --- |
| Typecheck | ❌ | 必须 PASS |
| Unit / Memory E2E | ❌ | 必须 PASS |
| PostgreSQL | ❌ | 必须 PASS |
| Phase 12 E2E | ❌ | 必须 PASS |
| Real Codex | ✅ | 无 Provider 时允许 |
| Docker / Resource | ✅ | 无 Docker 主机时允许 |

但是：

```text
Docker / Resource
```

至少必须成功执行过一次。

因此：

```text
Docker 从未执行
    ↓
不能 FROZEN
```

Real Codex 如果 Skip：

必须记录：

```text
SKIPPED
reason = provider unavailable
```

不能显示：

```text
PASSED
```

## 28. Docker Resource Gate

Docker Gate 使用代码中的实际资源命名约定。

### Run Containers

```bash
docker ps -a \
  --filter label=ai-harness.run-id \
  --format '{{.Names}}'
```

预期：

```text
empty
```

### Execution Networks

```bash
docker network ls \
  --filter name=ai-net- \
  --format '{{.Name}}'
```

预期：

```text
empty
```

### Allow-list Proxy

```bash
docker ps -a \
  --filter name=ai-proxy- \
  --format '{{.Names}}'
```

预期：

```text
empty
```

## 29. Workspace Resource Gate

Workspace 不能简单要求：

```text
workspace count == baseline
```

因为成功 Run 进入 Review 时 Workspace 按当前设计可能需要保留。

因此检查：

```text
Expected Resources
vs
Unexpected Resources
```

成功 Run：

```text
REVIEW
    ↓
Workspace may remain
```

失败：

```text
FAILED
    ↓
Workspace cleaned
```

Timeout：

```text
TIMED_OUT
    ↓
Workspace cleaned
```

Cancelled：

```text
CANCELLED
    ↓
Workspace cleaned
```

Lost：

```text
LOST
    ↓
Workspace cleaned
```

## 30. Execution Resource Gate

检查：

```text
Run
Execution
Container
Network
Proxy
Workspace
```

最终必须满足：

```text
terminal Run
    ↓
terminal Execution
    ↓
no unexpected container
    ↓
no unexpected network
    ↓
no leaked workspace
```

成功 Review Workspace 属于：

```text
expected persistent resource
```

不能误判为 leak。

## 31. Acceptance Matrix

正式记录：

| Area | Scenario | Expected |
| --- | --- | --- |
| Problem | create | Problem created |
| Problem | clarification | NEEDS_INPUT |
| Problem | answer | CONFIRMED |
| Specification | create | DRAFT |
| Specification | ready | READY |
| Planning | plan | Tasks created |
| Planning | replay | no duplicate |
| DAG | dependency | edge created |
| DAG | cycle | rejected |
| Scheduler | runnable | Run created |
| Scheduler | blocked | no Run |
| Run | success | REVIEW |
| Verification | multiple checks | aggregated |
| Verification | failure | FAILED + Evidence |
| Review | approve | DONE |
| Review | changes | READY |
| Delivery | all required DONE | READY_FOR_RELEASE |
| Delivery | failed required | BLOCKED |
| Delivery | dependency blocked | BLOCKED |
| Retry | failure | fresh Workspace |
| Recovery | LOST | recovered |
| Cancel | queued | CANCELLED |
| Cancel | active | cancellation processed |
| Cancel | terminal | rejected |
| Notification | ready | notified |
| Notification | blocked | notified |
| Release | ready | Release created |
| Release | repeat | idempotent |
| Release | Loop | no auto release |
| PostgreSQL | integration | PASS |
| Docker | cleanup | PASS |
| Real Codex | execution | PASS / allowed SKIPPED |

## 32. Gate Runner

最终提供统一 Release Gate。

建议新增 npm script：

```json
{
  "scripts": {
    "test:release-gate": "..."
  }
}
```

逻辑：

```text
Gate 1
  ↓
Gate 2
  ↓
Gate 3
  ↓
Gate 4
  ↓
Gate 5
  ↓
Gate 6
```

Gate 之间默认串行。

原因：

* Docker / Git / Workspace 操作较重
* PostgreSQL 资源独立但仍需可控
* 宿主机负载可能较高
* 避免测试竞争导致非确定性失败

必要时使用：

```bash
--no-file-parallelism
```

具体参数根据 Vitest 当前配置确定。

## 33. Release Gate Definition

最终 Gate 固定为：

```text
Gate 1
Typecheck

Gate 2
Unit + Memory E2E

Gate 3
PostgreSQL Integration

Gate 4
Phase 12 E2E

Gate 5
Real Codex E2E

Gate 6
Docker / Workspace / Execution Resource
```

其中：

```text
Gate 2
```

排除：

```text
**/*.integration.test.ts
```

避免 PostgreSQL / Real Codex 被意外包含。

## 34. Recommended Commands

### Gate 1

```bash
npm run typecheck
```

### Gate 2

```bash
vitest run --exclude '**/*.integration.test.ts'
```

### Gate 3

```bash
AI_TEST_REQUIRE_DB=1 \
vitest run tests/postgres.integration.test.ts
```

### Gate 4

```bash
vitest run tests/e2e/phase12
```

### Gate 5

```bash
AI_TEST_REQUIRE_DB=1 \
AI_TEST_CODEX=1 \
vitest run tests/realE2E.integration.test.ts
```

### Gate 6

执行 Resource Acceptance：

```bash
docker ps -a \
  --filter label=ai-harness.run-id \
  --format '{{.Names}}'

docker network ls \
  --filter name=ai-net- \
  --format '{{.Name}}'

docker ps -a \
  --filter name=ai-proxy- \
  --format '{{.Names}}'
```

具体 npm script 名称可根据现有 `package.json` 调整。

## 35. Vitest JSON Result

Release Gate 使用 Vitest JSON Reporter：

```bash
vitest run \
  --reporter=json \
  --outputFile=artifacts/phase12-release-gate.json
```

结果由 runner 解析：

```json
{
  "acceptance": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0
  }
}
```

这些数字必须来自测试 Runner 的实际结果。

禁止人工填写。

## 36. Artifacts

生成：

```text
artifacts/
└── phase12-release-gate.json
```

加入：

```text
.gitignore
```

Artifact 不提交 Git。

## 37. Gate Result

每个 Gate 必须产生：

```text
PASS
FAIL
SKIPPED
```

完整结果：

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
  "status": "PASS"
}
```

如果 Gate 为：

```text
SKIPPED
```

必须同时记录：

```text
reason
```

## 38. Three Consecutive Runs

Release Gate 不是只跑一次。

必须：

```text
Run #1 → PASS
Run #2 → PASS
Run #3 → PASS
```

连续三次通过。

目的：

验证：

* test isolation
* deterministic behavior
* workspace cleanup
* DB isolation
* concurrency
* resource cleanup

不存在：

```text
Run #1 PASS
Run #2 FAIL
Run #3 PASS
```

仍宣布 FROZEN。

## 39. Commit / Host / Date Record

每次最终 Gate 记录：

```text
commit SHA
host
date/time
```

例如：

```text
Commit:
abc123...

Host:
linux-builder-01

Date:
2026-09-20T...
```

这样未来可以回答：

> 这个 Phase 12 Release Gate 到底在哪台机器、哪个 commit 上通过的？

## 40. FROZEN Definition

Phase 12 FROZEN 必须同时满足：

```text
1. TASK-1201 ~ TASK-1207 已完成
2. TASK-1208 Acceptance 完成
3. Typecheck PASS
4. Unit / Memory E2E PASS
5. PostgreSQL PASS
6. Phase 12 E2E PASS
7. Docker / Resource 至少成功执行过一次
8. 连续三次 Release Gate PASS
9. 所有允许 SKIPPED 项均有明确原因
10. Acceptance Matrix 全部覆盖
11. docs/phase12-acceptance.md 完成
```

Real Codex 可以因为环境原因：

```text
SKIPPED
```

但必须有明确记录。

如果 Docker 从未成功运行：

```text
Phase 12 = NOT FROZEN
```

## 41. FROZEN Semantics

`PHASE 12 FROZEN` 的含义不是：

> 永远不能修改代码。

而是：

> TASK-1201～TASK-1207 所定义的 Phase 12 生产语义已经通过正式 Acceptance Gate；后续修改不得在没有新 Task / 新验收的情况下改变这些语义。

因此：

```text
Phase 12 Frozen
       ↓
bug discovered
       ↓
new Task
       ↓
change
       ↓
regression
       ↓
new Release Gate
```

而不是直接修改后继续声称：

```text
Phase 12 FROZEN
```

## 42. Operator Boundary Documentation

`docs/phase12-acceptance.md` 必须明确记录：

```text
Operator Boundary #1

Planning
  ↓
Task INBOX
  ↓
operator sets READY
```

以及：

```text
Operator Boundary #2

Task BLOCKED
  ↓
operator reset
  ↓
READY
```

说明：

```text
No task.ready command exists in current Phase 12.
TASK-1208 does not introduce one.
```

这些操作是：

```text
test/operator boundary
```

而不是正式产品流程。

## 43. Resource Acceptance Environment

Docker Resource Gate 依赖：

```text
Linux
Docker
Git
Node
PostgreSQL
```

如果没有 Docker 主机：

```text
Docker / Resource Gate = SKIPPED
```

但是：

```text
PHASE 12 FROZEN = prohibited
```

直到至少成功执行过一次 Docker / Resource Gate。

## 44. Acceptance Test Boundaries

E2E 测试应优先通过正式 Application / Command / Loop / Scheduler / Worker 入口驱动。

允许的例外：

```text
Operator Boundary
```

即：

```text
INBOX → READY
BLOCKED → READY
```

除此之外：

禁止为了方便测试直接：

```text
INSERT Run
INSERT Release
UPDATE Delivery
UPDATE Problem
```

来伪造被测试流程。

测试 helper 不得绕过被测试的业务边界。

## 45. Regression Boundary

TASK-1208 不修改：

```text
Scheduler semantics
Worker semantics
Loop semantics
Delivery aggregation semantics
Retry semantics
Cancellation semantics
Recovery semantics
Dependency semantics
Review semantics
Release semantics
```

如果实现过程中发现现有语义与 Acceptance 不一致：

```text
先确认现有语义
      ↓
更新 Acceptance
```

而不是为了让测试通过而顺手修改生产代码。

如果确实需要改变语义：

```text
TASK-1208 STOP
      ↓
new feature/design task
```

## 46. Acceptance Completion Criteria

TASK-1208 完成必须满足：

### Test Structure

* [ ] 不创建第二套 Phase 12 E2E
* [ ] 保留现有 Phase 12 测试
* [ ] 新增 `acceptance.test.ts`
* [ ] 使用 `.test.ts`

### Fixture

* [ ] `sample-project` 增加多 verification checks
* [ ] 无第三方 npm dependency
* [ ] 离线运行
* [ ] Real Codex fixture 不修改

### Isolation

* [ ] PostgreSQL 使用独立 database
* [ ] `AI_TEST_REQUIRE_DB=1`
* [ ] DB unavailable 时 FAIL
* [ ] postgres 与 realE2E 可独立运行
* [ ] 不互相清理数据

### Acceptance

* [ ] Problem
* [ ] Confirmation
* [ ] Specification
* [ ] Planning
* [ ] DAG
* [ ] Scheduling
* [ ] Run
* [ ] Workspace
* [ ] Verification
* [ ] Review
* [ ] Approval
* [ ] Delivery
* [ ] Failure
* [ ] Retry
* [ ] Recovery
* [ ] Cancellation
* [ ] Notification
* [ ] Human Release

### Resource

* [ ] Container cleanup
* [ ] Network cleanup
* [ ] Proxy cleanup
* [ ] Execution cleanup
* [ ] Workspace lifecycle
* [ ] Retry workspace isolation

### Gate

* [ ] Typecheck PASS
* [ ] Unit / Memory E2E PASS
* [ ] PostgreSQL PASS
* [ ] Phase 12 E2E PASS
* [ ] Real Codex PASS / documented SKIPPED
* [ ] Resource PASS / documented SKIPPED
* [ ] Resource 至少成功执行过一次
* [ ] 连续三次 Gate PASS

### Documentation

* [ ] `docs/phase12-acceptance.md`
* [ ] Acceptance Matrix
* [ ] Gate Policy
* [ ] SKIPPED Policy
* [ ] Operator Boundary
* [ ] Docker commands
* [ ] DB isolation
* [ ] Result format
* [ ] FROZEN definition

## 47. Final Phase 12 State

最终系统：

```text
                    ┌───────────────┐
                    │    Problem    │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │ Confirmation  │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │ Specification │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │    Planning   │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │ Dependency DAG│
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │   Scheduler   │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │      Run      │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │     Agent     │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │ Verification  │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │     Review    │
                    └───────┬───────┘
                            ↓
                         DONE
                            ↓
                    ┌───────────────┐
                    │    Delivery   │
                    └───────┬───────┘
                            ↓
                    READY_FOR_RELEASE
                            ↓
                    ┌───────────────┐
                    │ Human Release │
                    └───────┬───────┘
                            ↓
                         RELEASED
```

最终 Release Gate：

```text
Typecheck
    ↓
Unit / Memory E2E
    ↓
PostgreSQL
    ↓
Phase 12 E2E
    ↓
Real Codex
    ↓
Docker / Resource
    ↓
Acceptance Matrix
    ↓
3 consecutive PASS
    ↓
PHASE 12 FROZEN
```

TASK-1208 的最终产物不是新的业务功能，而是：

```text
A repeatable
generic
isolated
auditable
release gate
```

用于证明：

> Phase 12 已经从“功能实现完成”进入“可重复验收、可回归验证、边界明确”的冻结状态。

## 48. Phase 12 Release Gate Result（TASK-1208 验收记录）

```text
结论：        PHASE 12 FROZEN
日期：        2026-09-23
验收对象：    commit 77d7b55
              （相对 Step 4 基线 90fe47d 仅 scripts/verify-phase12.mjs 一个文件不同，
                `git diff --name-only 90fe47d..77d7b55` 已核对；
                src / tests / fixtures / migrations 与 90fe47d 完全一致，
                即 1201–1208 的验收语义就是 90fe47d 的语义）
主机：        <验收主机>（Linux 6.8.0 x86_64，Docker 29.7.2）
运行方式：    每次新建一次性 postgres:16-alpine 容器 →
              Runner 从零创建并迁移 ai_harness_it / ai_harness_real →
              AI_GATE_COMMIT=77d7b55 DATABASE_URL=…127.0.0.1:55432/ai_harness
              node scripts/verify-phase12.mjs
```

### 48.1 连续三次 Release Gate

| Run | 时间 (UTC) | typecheck | unit | postgres | phase12E2E | realCodex | resources (docker) | acceptance | overall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 2026-09-23T15:20:07Z | PASS | PASS 439 | PASS 13 | PASS 24 | SKIPPED | PASS (docker PASS) | 476 / 0 / 0 | **PASS** |
| #2 | 2026-09-23T15:24:01Z | PASS | PASS 439 | PASS 13 | PASS 24 | SKIPPED | PASS (docker PASS) | 476 / 0 / 0 | **PASS** |
| #3 | 2026-09-23T15:28:31Z | PASS | PASS 439 | PASS 13 | PASS 24 | SKIPPED | PASS (docker PASS) | 476 / 0 / 0 | **PASS** |

三次均满足：

```text
acceptance.failed = 0        acceptance.skipped = 0
docker = PASS                dockerGateEverPassed = true
每次 Runner 均报 created: ai_harness_it, ai_harness_real（各 12 migrations 全新迁移）
真实 codex：SKIPPED（主机无 codex provider，AI_TEST_CODEX 未 opt-in）—— 按 §9 政策记录，不当作 PASS
```

### 48.2 Docker Resource Gate（同主机，Step 5 实测）

```text
tests/dockerAcceptance.integration.test.ts                      10 passed / 3 skipped
tests/dockerAcceptance.integration.test.ts (+NETWORK_ENFORCEMENT) 12 passed / 1 skipped
tests/multiRepoDockerAcceptance.integration.test.ts               10 passed / 0 skipped

资源残留（三套件后 / 每次 Gate 后 / 全部结束后均核对）
  docker ps -a --filter label=ai-harness.run-id   → 0
  docker network ls --filter name=ai-net-         → 0
  docker ps -a --filter name=ai-proxy-            → 0
  /srv/ai-harness/.ai-workspaces*                 → 0
一次性 PostgreSQL 容器在每个 Run 结束后销毁（最终 0 个 phase12-gate-pg）
```

### 48.3 FROZEN 判定（对照 §40）

```text
1  TASK-1201 ~ 1207 完成                       ✅
2  TASK-1208 Acceptance 完成                    ✅
3  Gate 1 Typecheck PASS                        ✅（×3）
4  Gate 2 Unit / Memory E2E PASS                ✅（439 ×3）
5  Gate 3 PostgreSQL PASS                       ✅（13 ×3，独立库）
6  Gate 4 Phase 12 E2E PASS                     ✅（24 ×3）
7  Gate 6 Docker / Resource 至少成功一次         ✅（同主机多轮 docker PASS）
8  连续三次 Release Gate PASS                   ✅（#1/#2/#3）
9  所有 SKIPPED 项均有 reason                   ✅（real codex: provider unavailable）
10 Acceptance Matrix（§31）全部覆盖              ✅
11 docs/phase12-acceptance.md 完成并含结果记录    ✅（本节）
```

### 48.4 证据位置与冻结范围

```text
原始 JSON（不入库，.gitignore 内）
  artifacts/host-phase12/run1.json
  artifacts/host-phase12/run2.json
  artifacts/host-phase12/run3.json
  artifacts/host-phase12/host-history.jsonl

冻结范围：TASK-1201 / 1202 / 1203 / 1204 / 1205 / 1206 / 1207 / 1208

后续若要修改这些语义：建立新 Task + 新的 Acceptance Gate，
不在本冻结基线上直接修改（见 §41）。
```
