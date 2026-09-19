# Phase 12 — Engineering Delivery Loop

> 状态：路线确定（2026-09-20）。Phase 11 已冻结；本阶段不再扩展 Channel，
> 目标是让 Harness 能把一个需求持续推进到交付。
> TASK-1201（Specification Model）、TASK-1202（Specification → Task
> Planning）已实现；TASK-1203 起尚未开始。

## 目标链路

```text
Problem → Confirmation → Specification → Task → Dependency → Scheduler
        → Run → Verification → Review → Approval → Next Task → Release
```

当前系统已具备 Problem / Confirmation / Task / Run / Review；缺口是
**Specification 不是独立、可持久化、可验证的工程对象**。

## 任务顺序

```text
TASK-1201  Specification Model                      ✅ 完成
TASK-1202  Specification → Task Planning            ✅ 完成
TASK-1203  Task Dependency / DAG                    ← 当前
TASK-1204  Dependency-aware Scheduler
TASK-1205  Delivery / Release Model
TASK-1206  Delivery Loop
TASK-1207  Failure / Retry / Recovery Hardening
TASK-1208  Phase 12 Generic E2E Acceptance
```

## TASK-1201 Specification Model（设计）

```ts
interface Specification {
  id: string;              // spec-xxxx
  problemId: string;       // 来源 Problem
  title: string;
  summary: string;         // 要做什么（来自 confirmed problem/expected 或人工填写）
  requirements: string[];  // 功能需求
  acceptance: string[];    // 验收标准（未来注入 Task.acceptance）
  constraints: Record<string, unknown>;
  targets: SpecificationTarget[];  // 目标仓库（primary/supporting）
  status: "DRAFT" | "READY" | "PLANNED" | "SUPERSEDED";
  createdAt: string;
  updatedAt: string;
}

interface SpecificationTarget {
  repositoryId: string;
  role: "primary" | "supporting";
  position: number;
  baseRef?: string;
}
```

状态与规则：

```text
DRAFT     可编辑（requirements/acceptance/targets）
READY     验收标准非空、至少一个 target；可进入 Task Planning
PLANNED   已由 Task Planning 消费（TASK-1202）
SUPERSEDED 被新 Specification 取代
```

- 恰好一个 primary target；同一 Specification 内 repository 不重复
- `acceptance` 为空时不允许 READY（避免"没有验收标准的计划"）
- Specification 属于 Problem；Problem 决定其来源，Specification 不反向控制
  Problem 生命周期

## 明确不做（TASK-1201）

```text
❌ Task Planning（TASK-1202）
❌ Dependency / DAG（TASK-1203）
❌ Scheduler 改造（TASK-1204）
❌ Release/Delivery 模型（TASK-1205+）
❌ CLI/Channel 命令（随 1202 接线）
```

## TASK-1201 实现（已完成）

```text
src/domain/specification.ts              # Specification / SpecificationTarget / 规则
src/store/specificationStore.ts          # 持久化契约
src/store/inMemorySpecificationStore.ts  # 测试/内存模式
src/store/postgresSpecificationStore.ts  # PostgreSQL（迁移 008）
src/specification/application/service.ts # SpecificationService
migrations/008_specifications.sql        # specifications + specification_targets
```

生命周期规则（由 `SpecificationService` 拥有，store 只做持久化）：

```text
createFromProblem  Problem 必须 CONFIRMED；summary/requirements/constraints/targets
                   从 problem.confirmedSpec 与 problem.repositoryId 推导（可覆盖）
update             仅 DRAFT 可编辑（specification_not_editable）
markReady          DRAFT → READY；验收标准为空 / 无 target 时
                   specification_incomplete（附 issues）
supersede          → SUPERSEDED（幂等）
```

事件（可选注入 `EventStore`，失败不影响主流程）：
`specification.created` / `specification.ready` / `specification.superseded`，
`problemId` 关联来源 Problem，payload 携带 `specificationId`。

刻意未做：

```text
❌ 不改动 problems 状态（Problem 生命周期仍由 Confirmation Loop 拥有）
❌ 不生成 Task（TASK-1202）
❌ 不引入 Dependency / DAG / Scheduler 变化
❌ 不加 CLI/Channel 命令
```

## Phase 12 进度

```text
TASK-1201  Specification Model                 ✅ 实现完成（迁移 008 + 单测 + Postgres 集成）
TASK-1202  Specification → Task Planning       ✅ 实现完成（迁移 009 + Command/CLI + E2E）
TASK-1203  Task Dependency / DAG               ← 下一步
TASK-1204  Dependency-aware Scheduler
TASK-1205  Delivery / Release Model
TASK-1206  Delivery Loop
TASK-1207  Failure / Retry / Recovery Hardening
TASK-1208  Phase 12 Generic E2E Acceptance
```

## TASK-1202 Specification → Task Planning（已完成）

```text
READY Specification
   ↓  TaskPlanner（DeterministicTaskPlanner，离线）
   ↓  Plan Items
   ↓  N Tasks（INBOX，不进入 Scheduler）
PLANNED Specification
```

实现：

```text
src/domain/specificationPlan.ts                    # PlanItem + 确定性 id
src/specification/application/planner.ts            # TaskPlanner / Deterministic / Scripted
src/specification/application/planning.ts           # PlanningService（plan / show）
src/store/specificationPlanStore.ts                 # 持久化契约
src/store/inMemorySpecificationPlanStore.ts         # 测试/内存模式
src/store/postgresSpecificationPlanStore.ts         # PostgreSQL（迁移 009）
src/command/handlers/specification.ts               # spec.show / spec.plan
src/channel/rendering/specification.ts              # Specification → OutgoingMessage
src/cli/specificationOutput.ts + `ai spec show|plan` # CLI 经 Command 进入 Application
migrations/009_specification_plans.sql              # specification_plans
```

映射规则：

```text
Task.repositoryId ← primary target
Task.targets      ← Specification.targets（primary/supporting + baseRef）
Task.acceptance   ← Specification.acceptance
Task.title        ← plan item title（有 requirements 时 = 逐条 requirement）
Task.description  ← Specification.summary + plan item description
Task.status       ← INBOX（planning 不调度、不建 Run、不跑 Agent）
```

幂等与恢复（三层，均有数据库兜底）：

```text
1. 已有 plan → 直接返回（replayed=true），绝不产生第二批 Task
2. READY → PLANNED 用 compare-and-set（updateSpecificationStatusIf）抢占，
   只有一个调用者能开始 planning
3. plan item id = plan-<specId>-<position>，task id = task-<specId>-<position>；
   UNIQUE(specification_id, position) 与 tasks.id 是库级兜底 ——
   崩溃后重跑只会补齐缺失的 Task，不会重复创建
```

`specification_plans` 刻意不使用 `UNIQUE(specification_id)`：一个 Specification
对应 N 个 plan item（= N 个 Task），"只规划一次"由上面的 compare-and-set +
`UNIQUE(specification_id, position)` 保证；`UNIQUE(task_id)` 保证一个 Task 只归属
一个 plan item。

撤回/拒绝语义：

```text
DRAFT / 非 READY           → rejected(specification_not_ready)
READY 但缺验收标准/target   → rejected(specification_incomplete, issues[])
planner 产出为空            → rejected(plan_empty)，状态回滚到 READY
未知 Command / 非法 payload → rejected（TASK-1106 的校验表，未进 Application）
guest 执行 spec.plan        → rejected(unauthorized)
```

未做（按边界）：LLM Planner、Task Dependency/DAG（TASK-1203）、Scheduler/Worker/
Run 改动、自动执行 Task、新 Task 模型。
