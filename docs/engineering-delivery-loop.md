# Phase 12 — Engineering Delivery Loop

> 状态：路线确定（2026-09-20）。Phase 11 已冻结；本阶段不再扩展 Channel，
> 目标是让 Harness 能把一个需求持续推进到交付。
> TASK-1201（Specification Model）、TASK-1202（Specification → Task
> Planning）、TASK-1203（Task Dependency / DAG）、TASK-1204
> （Dependency-aware Scheduler）、TASK-1205（Delivery / Release Model）
> 、TASK-1206（Delivery Reconciliation Loop）已实现；TASK-1207 起尚未开始。

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
TASK-1203  Task Dependency / DAG                    ✅ 完成
TASK-1204  Dependency-aware Scheduler               ✅ 完成
TASK-1205  Delivery / Release Model                 ✅ 完成
TASK-1206  Delivery Loop                            ✅ 完成
TASK-1207  Failure / Retry / Recovery Hardening     ✅ 完成
TASK-1208  Phase 12 Generic E2E Acceptance          ← 当前（设计定稿，待实现）
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
TASK-1203  Task Dependency / DAG               ✅ 实现完成（迁移 010 + Service + E2E）
TASK-1204  Dependency-aware Scheduler          ✅ 实现完成（迁移 011 + Scheduler + E2E）
TASK-1205  Delivery / Release Model            ✅ 实现完成（迁移 012 + Command/CLI + E2E）
TASK-1206  Delivery Loop                       ✅ 实现完成（Loop 接入 + Notifier + E2E）
TASK-1207  Failure / Retry / Recovery Hardening  ✅ 实现完成（Phase A–D，见
                                                 failure-recovery-hardening.md）
TASK-1208  Phase 12 Generic E2E Acceptance      设计定稿，实现待开始
                                                （docs/phase12-acceptance.md）
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

## TASK-1203 Task Dependency / DAG（已完成）

```text
Task  ←──── depends on ────  Task      （DAG，可跨 Specification）
        TaskDependencyService → 领域校验 → TaskDependencyStore
        Scheduler 只消费"合法图"（DAG-aware 选取 = TASK-1204）
```

实现：

```text
src/domain/taskDependency.ts                  # 边模型 + 环检测 + runnable 判定
src/task/application/dependencyService.ts     # TaskDependencyService
src/store/taskDependencyStore.ts              # 持久化契约
src/store/inMemoryTaskDependencyStore.ts
src/store/postgresTaskDependencyStore.ts
migrations/010_task_dependencies.sql          # PK(task_id,depends_on_task_id) + CHECK + 反向索引
```

语义与约束：

```text
Task B depends_on Task A  ⇒  B 必须等 A 完成（A 是 B 的前置）
UNIQUE(task_id, depends_on_task_id)   # 不产生重复边
CHECK(task_id <> depends_on_task_id)  # 禁止自依赖
index (depends_on_task_id)            # 反向查询"谁在等这个 Task"
```

`TaskDependencyService` 承担图的合法性（两个 Task 必须存在、禁止自依赖、DFS 环检测
`task_dependency_cycle`、重复添加幂等返回 `created:false`），并暴露可执行判定：

```text
runnable = Task.status == READY AND 所有前置 Task.status == DONE

A DONE  + B READY → B runnable
A REVIEW+ B READY → B 不可执行（审批才是真正的完成点）
```

查询能力：`isRunnable(taskId)` / `listRunnableTasks()` / `listDependents(taskId)` /
`describe(taskId)`（前置、后继、边）。这些是**查询**，不改变 Scheduler：

```text
TASK-1203 只建立 DAG 能力；Scheduler 仍按原逻辑选择 READY Task
→ DAG-aware 选取、并行、调度顺序全部留给 TASK-1204
```

刻意未做：Scheduler 选取逻辑、Worker/Run/Agent/Retry 改动、把 `dependsOn` 塞进
`Task.constraints`、Specification 级依赖限制（允许跨 Specification 建边）。

## TASK-1204 Dependency-aware Scheduler（已完成）

```text
READY Tasks（既有优先级/创建时间排序）
   ↓  过滤：TaskDependencyService.listRunnableTasks()（Scheduler 不查图、不 DFS）
   ↓  过滤：已被 active run 占用的 Task
   ↓  max_concurrency 仍有余量？
   ↓
createRun → QUEUED（Worker 再接管）
```

实现：

```text
src/scheduler/scheduler.ts        # RunnableTaskQuery 端口 + runnable 过滤
src/cli/index.ts                  # ai loop 注入 TaskDependencyService
src/task/application/dependencyService.ts   # 提供 listRunnableTasks/isRunnable/describe
migrations/011_active_run_uniqueness.sql    # 每 Task 至多一个 active Run（部分唯一索引）
```

边界与语义：

```text
- Scheduler 只做"选择 + 调度"：不做环检测、不查 task_dependencies、不改 Task 状态机
- 依赖不消耗 concurrency slot：只有真正创建的 Run 占位
- 无依赖 Task（dependencies = []）天然 runnable → 旧数据零迁移
- READY 但依赖未 DONE 的 Task 不被选中，也**不隐藏**：
  task.show 显示 Status/Runnable/Dependencies（✓ DONE / ⏳ 其他状态）
- 失败语义不变：A FAILED 不满足依赖；A 若按现有策略回到 READY，
  Scheduler 可再次调度 A，但 B 仍要等 A → DONE（审批才是完成点）
```

并发保护（原状态 + 本次补齐）：

```text
既有：listRuns(ACTIVE) + busyTaskIds 过滤（进程内）
本次：runs_active_task_idx —— UNIQUE(task_id) WHERE status IN
      (QUEUED, STARTING, RUNNING, VERIFYING)
  → 两个 Scheduler 同时 tick 时，失败的插入转成 DuplicateActiveRunError，
    Scheduler 跳过该 Task；终态 Run 不受影响，retry/attempt 计数照旧
  → 直接 createRun（如 ai run / task.run）撞上 active run 时：
    RunStore 抛 DuplicateActiveRunError，命令层转成
    rejected(task_already_running)
```

刻意未做：DAG-aware 之外的新调度策略（公平性/优先级反转）、依赖失败级联
（`dependency_failed` / auto-unblock，留待 Delivery Policy）、Worker/Run/Retry 改动。

## TASK-1205 Delivery / Release Model（已完成）

```text
Specification 1:1 Delivery 1:N Release

Task facts（required / status）
        ↓  aggregate
Delivery.status（PLANNED → IN_PROGRESS → READY_FOR_RELEASE → RELEASED）
        ↓  人工确认
Release(RELEASED)  ← 只是记录，不是发布动作
```

实现：

```text
src/domain/delivery.ts                     # Delivery/Release + 聚合规则
src/delivery/application/service.ts        # DeliveryService（refresh/show/release）
src/store/{deliveryStore,inMemoryDeliveryStore,postgresDeliveryStore}.ts
migrations/012_deliveries.sql              # deliveries + releases
src/command/handlers/delivery.ts           # delivery.show / delivery.release
src/channel/rendering/delivery.ts          # Delivery → OutgoingMessage
src/cli/deliveryOutput.ts + ai delivery show|release
src/specification/application/planning.ts  # spec.plan 成功后自动建 Delivery
```

聚合规则（**只看 required Task**，Optional 不阻塞）：

```text
no required tasks                      → PLANNED
任一 required Task BLOCKED / FAILED     → BLOCKED（FAILED 也需要人工决策）
全部 required Task DONE                → READY_FOR_RELEASE
其他                                   → IN_PROGRESS
RELEASED                               → 人工动作，不被聚合覆盖
```

Task 的 required 语义直接复用 `TaskTarget.required`（primary target）：不新增
Task 字段，也不建立 `tasks.delivery_id` —— Delivery 通过
`specification_plans` 找到自己的 Task 集合。

Delivery status **不是写死的事实**：每次 `show` / `release` 都从当前 Task 状态
重新聚合；persist 的状态只用于"状态迁移可观测"+ 事件触发。因此：

```text
A DONE + B DONE → READY_FOR_RELEASE
B → BLOCKED     → 再次 show 得到 BLOCKED（回归可见）
```

事件（迁移时才产生，重复 `show` 不重复触发）：
`delivery.created` / `delivery.in_progress` / `delivery.ready_for_release` /
`delivery.blocked` / `release.created` / `release.released`
（`delivery.in_progress` 是对"READY_FOR_RELEASE 回归"的审计补充。）

Release 语义与幂等：

```text
delivery.release 前置：Delivery.status == READY_FOR_RELEASE
  否则 rejected(delivery_not_ready_for_release)
成功：Release(RELEASED, createdBy=channel:user) + Delivery=RELEASED
重复：返回已有 Release（created:false），不产生第二条
DB 兜底：READY_FOR_RELEASE → RELEASED 用 compare-and-set 抢占；
        releases_one_released_idx = UNIQUE(delivery_id) WHERE status='RELEASED'
```

命令/CLI：`delivery.show`（所有角色）、`delivery.release`（reviewer/admin）；
`ai delivery show|release` 经 Command 层进入 Application。**没有**
`delivery.create` —— Delivery 由 `spec.plan` 自动建立（1 Specification : 1 Delivery，
`UNIQUE(specification_id)`）。

刻意未做：GitHub/GitLab/PR/Merge/Push/Deploy/CI-CD/自动发布/回滚/版本化发布流水线。

## TASK-1206 Delivery Reconciliation Loop（已完成）

```text
Loop.tick()
├── recover expired runs / consume cancel requests
├── reconcile deliveries        ← 观察外部/恢复带来的 Task 变化
├── schedule tasks               ← DAG-aware（1204）
├── execute queued runs
└── reconcile deliveries        ← 同 tick 内 Run 完成 → Task DONE 也能被看到
   （两次调用合并成一份 report；幂等所以不会重复事件）
```

实现：

```text
src/delivery/application/service.ts      # reconcile / reconcileAll（唯一聚合权威）
src/delivery/application/notifier.ts     # DeliveryNotifier + Noop/Recording
src/delivery/application/reconciler.ts   # DeliveryReconciler（聚合 → 变更 → 通知）
src/loop/loop.ts                         # DeliveryReconcilerPort + TickReport 字段
src/cli/index.ts                         # ai loop 注入 reconciler（CLI notifier）
```

语义：

```text
聚合规则只有一处权威实现（DeliveryService），Loop/Reconciler 不复制规则
只有真正发生状态迁移才产生 Event 与通知：
  IN_PROGRESS → READY_FOR_RELEASE → 通知（delivery.ready_for_release）
  → BLOCKED                       → 通知（delivery.blocked）
  created / in_progress / release.* → 只记录，不通知
RELEASED 不被聚合覆盖（Release 是人工记录）
通知失败：记录在 TickReport.deliveryNotificationFailures，
          **不回滚** 已持久化的状态迁移；失败的通知进入 pending，
          下一次 reconcile 重试（只重发消息，不重复状态迁移 Event）
```

`TickReport` 新增：`deliveryTransitions` / `deliveryNotifications` /
`deliveryNotificationFailures`；`ai loop --once` 输出对应计数。

刻意未做：自动 release、自动 merge/deploy、修改 Scheduler/Worker 语义、
创建 Task/Run、修改 Task 状态、Notification Queue（失败重试只在内存 pending 中）。
