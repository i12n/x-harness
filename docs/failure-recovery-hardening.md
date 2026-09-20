# TASK-1207 — Failure / Retry / Recovery Hardening（设计稿）

> 状态：**Phase A、Phase B、Phase C 已实现**（2026-09-20）；Phase D 尚未开始。
> 前置：TASK-1201–1206 已完成并冻结（Specification / Planning / DAG /
> DAG-aware Scheduler / Delivery + Release / Delivery Reconciliation）。

## 0. 目标与非目标

目标：在失败、重试、恢复场景下保持**系统一致性**与**可观察性**，不重新设计
Task / Run 状态机，不改变 Scheduler / Worker 执行语义。

```text
Task Failure
   ↓
Dependency Impact（计算事实）
   ↓
Runnable / Waiting / Dependency-Blocked
   ↓
Delivery Aggregate（唯一权威仍在 DeliveryService）
   ↓
Loop Reconciliation
   ↓
Failure Visibility（blocking chain + evidence）→ Notification
```

非目标：新建 Failure / Retry 业务对象、新增 TaskStatus、自动把下游 Task 改成
BLOCKED、自动 Release、Git/PR/Merge/Deploy、LLM 推断失败原因、持久化
Notification Queue、Scheduler / Worker 重构。

## 1. 现状核对（实现前必须先接受这些代码事实）

| 事实 | 位置 | 对 1207 的影响 |
| --- | --- | --- |
| 系统产生的 Task 失败终态是 **BLOCKED**（attempt 用尽） | `worker.recoverTask`、`loop.releaseTask` | 级联必须把 BLOCKED 与 FAILED 同等对待 |
| `Task FAILED` 是合法枚举，但**系统不会写入**（仅人工/外部/测试） | `domain/task.ts` | 仍需支持：聚合规则已按 FAILED 处理 |
| attempts 未用尽时失败 → Task 回 **READY**，下一 tick 自动重试（新 Run + 新 Workspace） | `worker.recoverTask` | 1207 不新增重试入口，只补回归与可观察性 |
| 重试的并发保护来自 DB：`runs_active_task_idx` | 迁移 011 | 所有重试路径必须继续把 `23505` 转成 `DuplicateActiveRunError` |
| 失败证据已持久化：`run.error.verification[]`、`run.error.failingTargets[]`、`run.exitCode`、`run.result.agentStderr` | `worker.failRun` | Failure reason 直接取这些字段，不新增对象 |
| Delivery 聚合权威只有一处 | `domain/delivery.aggregateDeliveryStatus` + `DeliveryService.aggregate` | 1207 只**扩展输入事实**，不复制规则 |

## 2. 核心设计 A — Dependency Impact（纯 Domain）

### 2.1 计算事实，不是状态迁移

```text
Runnable            READY + 所有 dependency = DONE
Waiting             READY + 存在 dependency != DONE + 无失败阻塞链
Dependency-Blocked  READY + 存在（直接或传递）失败祖先 FAILED / BLOCKED
```

**不修改 Task 状态**：B 仍然是 `READY`，只是 `runnable=false`、
`dependencyBlocked=true`。Scheduler 的选取条件因此**一行都不用改**（它本来
就只调度 runnable 的 READY Task）。

### 2.2 新增 API（`src/domain/taskDependency.ts` 扩展）

```ts
export interface TaskDependencySnapshot {
  tasks: { id: string; status: TaskStatus }[];
  dependencies: { taskId: string; dependsOnTaskId: string }[];
}

export interface TaskDependencyImpact {
  runnable: boolean;
  waiting: boolean;
  dependencyBlocked: boolean;
  /** 失败祖先（FAILED / BLOCKED），含传递；确定性排序 */
  blockingTaskIds: string[];
  /** 用于展示的最短阻塞链：failedTask → … → 当前 Task */
  blockingChain: string[];
  /** 悬空依赖（Postgres FK 下不应出现；内存模式可观测） */
  missingTaskIds: string[];
}

export const DEPENDENCY_FAILURE_STATUSES: TaskStatus[] = ["FAILED", "BLOCKED"];

export function getTaskDependencyImpact(
  taskId: string,
  snapshot: TaskDependencySnapshot,
): TaskDependencyImpact;
```

规则细节（固定下来，避免实现时分歧）：

1. `runnable` 与现有 `isTaskRunnable()` 完全一致（复用同一实现，避免第二套判定）。
2. `dependencyBlocked` 只在 `task.status === "READY"` 时为 true；已 RUNNING /
   REVIEW / DONE 的 Task 不再“被依赖阻塞”（它已经跑起来了）。
3. `blockingTaskIds` / `blockingChain` 始终从 DAG 计算（纯事实），但只在
   `dependencyBlocked` 时用于渲染。
4. 链的确定性：按 `dependsOn` 边的 BFS 层序 + taskId 字典序（同一输入必然同一
   输出，便于测试与快照）。
5. 传递阻塞：`A FAILED → B → C` 时 C 的 `blockingTaskIds = [A]`，
   `blockingChain = [A, B, C]`。
6. 无依赖 Task：`runnable = (status === "READY")`，行为与 1203 完全一致。

### 2.3 Service 层接线（`src/task/application/dependencyService.ts`）

```ts
async getImpact(taskId: string): Promise<TaskDependencyImpact>
async describe(taskId): Promise<TaskDependencyView>   // + impact + blockingChain
```

`listRunnableTasks()` / `isRunnable()` 语义**不变**（仍是 Scheduler 的唯一入口）。

## 3. 核心设计 B — Blocking Chain + Failure Evidence

### 3.1 Failure evidence 提取（纯 Domain）

```ts
// src/domain/failureEvidence.ts（新）
export interface FailureEvidence {
  kind: "verification" | "agent" | "timeout" | "cancelled" | "lost" | "unknown";
  command?: string;
  exitCode?: number | null;
  output?: string;        // 已截断
  message?: string;
  targets?: { targetId?: string; repositoryId?: string; error?: string }[];
}

export function extractFailureEvidence(
  run: Pick<Run, "status" | "exitCode" | "result" | "error"> | undefined,
  options?: { maxOutputChars?: number },
): FailureEvidence | undefined;
```

来源优先级（只读已存在的事实，不推断）：

```text
run.error.failingTargets[].checks[]（command/exitCode/output）
  → run.error.verification[]
  → run.result.targets[].checks[]
  → run.status（TIMED_OUT / CANCELLED / LOST）+ 对应 error/result 说明
```

与 `channel/rendering/common.collectRunTargets()` 的关系：后者继续服务 Run/Review
卡片；`extractFailureEvidence` 是 domain 级的“单条失败摘要”，供 Delivery / Task
视图复用。两者读的是**同一批持久化字段**，不引入第二套事实来源。

### 3.2 Delivery 维度的阻塞事实

```ts
export interface DeliveryBlockingFact {
  taskId: string;
  taskTitle: string;
  /** 该 Task 自身的终态；dependency-blocked 的 required Task 记 dependency-blocked */
  state: "FAILED" | "BLOCKED" | "dependency-blocked";
  blockingTaskIds: string[];
  chain: { taskId: string; status: TaskStatus; note?: string }[];
  evidence?: FailureEvidence;
}

export interface DeliveryAggregate {
  status: DeliveryStatus;
  requiredTasks: Task[];
  blockingFacts: DeliveryBlockingFact[];
}
```

`DeliveryService` 新增两个**可选**依赖（缺省时降级为 1205 的纯状态聚合，保证
1205/1206 的测试与调用点不受影响）：

```ts
DeliveryServiceDeps {
  deliveries; plans; tasks; events?;
  runs?: RunStore;                    // 最新失败 Run → evidence 来源
  dependencies?: TaskDependencyStore; // impact / chain 来源
}
```

### 3.3 通知 payload 扩展

`delivery.blocked` 仍由 1206 的 `DeliveryReconciler` 触发（触发条件不变），消息体
扩展为：

```text
Delivery blocked
Specification: spec-xxx

Required Tasks:
  ✓ Task A — DONE
  ✗ Task B — BLOCKED
  · Task C — blocked by Task B

Blocking chain:
  Task B
    ↓
  Task C

Failure:
  verification: npm test (exit 1)
  <截断输出>
```

Renderer 只做事实 → `MessageBlock`；不做重试/审批/通知决策，也不推测原因。

## 4. Delivery Aggregate 扩展（唯一需要拍板的语义变化）

现有规则（1205，保持不动）：

```text
无 required Task             → PLANNED
任一 required BLOCKED/FAILED  → BLOCKED
全部 required DONE           → READY_FOR_RELEASE
其他                         → IN_PROGRESS
RELEASED 不被覆盖；optional Task 不影响状态；每次读取重算，回归可见
```

### 决策 D1（建议采纳）

问题场景：

```text
optional Task X = BLOCKED
required Task B depends on X   → B 永远不可执行
required Task A = DONE
```

按 1205 规则，Delivery 永远停在 `IN_PROGRESS`，但事实上永远无法交付 —— 正是
本任务要解决的问题。

建议扩展（**只加一条分支**，不改既有分支）：

```text
任一 required Task 处于 dependency-blocked（上游 FAILED/BLOCKED）
    → BLOCKED
```

实现方式：`aggregateDeliveryStatus(tasks, impacts?)` 增加可选第二参数；不传
`impacts` 时行为与 1205 完全一致（现有单测与调用点零改动）。

如果你希望 Delivery 不因此判 BLOCKED（只展示 chain，状态仍 IN_PROGRESS），
实现时把这条做成开关即可；默认按建议开启。

## 5. Retry / Workspace / Recovery Hardening

### 5.1 保持现有语义（不新增对象与入口）

```text
Run FAILED → Task READY（attempts 未用尽）→ Scheduler → 新 Run（新 Workspace）
attempts 用尽 → Task BLOCKED → 人工决策（task validate / review.request_changes）
              → READY → 新 Run（新 Workspace）
LOST / TIMED_OUT / CANCELLED → 现有清理路径（TASK-1010）不变
```

1207 在这一块**只做验证与补强**，不写新状态机、不新增重试入口。

### 5.2 需要新证明的不变量

```text
workspace(run-1) ≠ workspace(run-2)            # 每个 attempt 全新目录/分支
WA1 ≠ WA2, WB1 ≠ WB2, WA1 ≠ WB2                # 多 target 每次 attempt 都独立
失败的 Target 不污染另一个 Target 的 Workspace
cleanup 只回收本次 Run 的 Workspace（不碰其他 Run / 其他 Target）
Run recovery 用 executions.mounts（持久化）定位 Workspace，而非 run.result
cancel / timeout / lost 均不留下孤立 Workspace
```

若回归测试证明现有实现已满足（预期如此，Phase 10 Release Gate 已覆盖大部分），
1207 不为了“有改动”而改代码。

## 6. Loop Error Isolation

主流程不变（1206 的 tick 顺序保持），只增加**阶段级错误隔离**：

```text
Loop.tick()
├── recover            ┐
├── cancel reconcile   │
├── delivery reconcile ├── try/catch → report.errors[]
├── schedule           │
├── execute            │
└── delivery reconcile ┘
```

```ts
export interface TickError { phase: string; message: string; }
TickReport.errors: TickError[];
```

语义：单阶段异常不再中断整个 tick，后续阶段继续执行；`errors` 通过 `TickReport`
与 `ai loop --once` 输出暴露。

**决策 D4**：v1 只进 report + CLI 计数，不新增 event 类型（避免 Loop 抖动污染
事件表）；如果希望可审计，可加 `loop.phase_failed` 事件。

注意：`executeQueued` 内部已按 run 隔离（Phase 8/10），这里只补 recover /
cancel / reconcile / schedule 的外层保护。

## 7. Notification Pending 边界（v1）

继续 1206 的内存 pending，只把边界写死：

```text
容量           100（FIFO）
单次发送上限   20（每个 pass）
顺序           确定性 FIFO（入队顺序 = 迁移顺序）
失败保留       保留，下一 pass 重试
超容量         丢弃**最新**（drop-newest）并记录 failure
投递语义       at-least-once（重试可能重复消息；无持久去重 —— 不在 1207 范围）
不变量         通知丢失/重复**绝不**改变 Delivery 状态或重复状态迁移事件
```

## 8. Commands / Renderer（仅追加）

```text
task.show       + Runnable: yes/no
                + Dependency blocked: yes/no
                + Blocked by: <taskId — STATUS> …
                + Latest failure: verification: npm test (exit 1) [截断]
delivery.show   + Blocking chain（含 dependency-blocked 的 required Task）
                + Failure（evidence）
```

新增字段只追加、不改名，既有字段保持不变；Renderer 不决定 retry / approval /
notification。

## 9. 测试矩阵 → 文件映射

| # | 场景 | 文件 |
| --- | --- | --- |
| 1–6 | `getTaskDependencyImpact`（FAILED / BLOCKED / 传递 / 旁支 / runnable / 无依赖） | `tests/taskDependencyImpact.test.ts`（新） |
| 7–12 | Delivery blocked、chain 可见、失败后恢复、RELEASED 保护 | `tests/delivery.test.ts` + `tests/deliveryReconciliation.test.ts`（扩展） |
| 13–19 | Retry 新 Workspace、多 target 隔离、cleanup（failed / timeout / lost） | `tests/workerRetry.test.ts`（新，沿用 git fixture） |
| 20–24 | Loop 阶段错误隔离、pending 重试与容量、重复 tick 幂等 | `tests/loop.test.ts` + `tests/deliveryReconciliation.test.ts`（扩展） |
| 25–27 | 并发 retry / scheduler / recovery+scheduler 无重复 active Run | `tests/postgres.integration.test.ts`（扩展，DB 兜底） |
| E2E | Specification → Planning → A/B → Run A 失败 → Delivery BLOCKED + 通知 → 重试（新 Workspace）→ PASS → B runnable → DONE → READY_FOR_RELEASE → 不自动 Release | `tests/e2e/phase12/failure-recovery.test.ts`（新） |

E2E 使用 `tests/fixtures/sample-project/`，不绑定任何具体业务项目；失败由
`ProbeEngine` 写错内容触发 verification failure（离线、确定性）。

E2E 中 Task 的失败终态按代码事实使用 **BLOCKED**（maxAttempts=1），重试入口复用
现有语义（等价于 `task validate` 的 application 调用 → READY）；`Task FAILED`
（人工/外部写入）的级联在单测中覆盖。

## 10. 实施顺序（先 Domain + Service + 测试）

```text
Phase A  Domain + Service + 单测
         getTaskDependencyImpact / blockingChain / extractFailureEvidence
         TaskDependencyService.getImpact / describe 扩展
         aggregateDeliveryStatus(tasks, impacts?) + DeliveryBlockingFact
         测试矩阵 1–12

Phase B  Loop hardening
         TickReport.errors 阶段隔离；pending 容量 / FIFO / 单次上限
         测试矩阵 20–24

Phase C  Commands / Renderer / CLI 可见性
         task.show / delivery.show 扩展字段；渲染 chain 与 evidence

Phase D  Retry / Workspace / 并发回归 + Generic E2E
         测试矩阵 13–19、25–27 与 E2E
```

每个 Phase 的完成标准：`npm run typecheck` ✅、`npm test` ✅、Postgres 集成 ✅
（单独运行）、real codex E2E ✅（单独运行）。

### Phase A 实现记录（已完成）

```text
src/domain/taskDependency.ts        # TaskDependencySnapshot / Impact /
                                    # DEPENDENCY_FAILURE_STATUSES /
                                    # getTaskDependencyImpact（纯函数，
                                    # runnable 复用 isTaskRunnable）
src/domain/failureEvidence.ts       # FailureEvidence + extractFailureEvidence
src/domain/delivery.ts              # aggregateDeliveryStatus(tasks, impacts?)（D1）
                                    # + DeliveryBlockingFact /
                                    #   collectDeliveryBlockingFacts
src/task/application/dependencyService.ts   # getImpact() + describe().impact
src/delivery/application/service.ts         # impacts / runs 端口，
                                            # blockingFacts + evidence
tests/taskDependencyImpact.test.ts  # 9 例（矩阵 1–6 + 边界）
tests/failureEvidence.test.ts       # 6 例
tests/delivery.test.ts              # +4 例（D1 / chain / evidence / 恢复）
tests/taskDependency.test.ts        # +4 例（service impact / dangling / describe）
```

实现期相对设计稿的一处偏差（有意）：

```text
设计稿写 DeliveryServiceDeps.dependencies?: TaskDependencyStore
实际实现为 impacts?: DeliveryImpactSource（TaskDependencyService 结构化满足）
原因：图的闭包遍历只应有一份实现，Delivery 侧不重复实现 DAG 遍历。
```

`Scheduler` / `Worker` / `Loop` 在 Phase A 中**一行未改**（可用 `git show --stat`
核对）。1205 的聚合行为在不传 `impacts` 时保持不变（未提供 impacts 的调用点与
原有单测全部通过）。

### Phase B 实现记录（已完成）

```text
src/loop/loop.ts                     # LoopPhase / LoopError / TickReport.errors
                                     # + runPhase() 阶段隔离 + toLoopError()
                                     # + TickReport.deliveryPendingNotifications
src/delivery/application/reconciler.ts  # 有界 pending 队列（FIFO / 容量 /
                                        # maxPerPass / drop-newest /
                                        # droppedNotifications）
src/delivery/application/notifier.ts    # RecordingDeliveryNotifier.failingTimes()
src/cli/index.ts                        # loop --once 输出 loopErrors /
                                        # deliveryPendingNotifications 与逐条错误
tests/loop.test.ts                      # +3 例（矩阵 20/21/24）
tests/deliveryReconciliation.test.ts    # +4 例（矩阵 22/23 + 常量）
tests/e2e/phase12/delivery-loop.test.ts # +1 例（跨 tick 通知重试）
```

`TickReport.errors` 结构（实际实现）：

```ts
type LoopPhase = "recover" | "cancel" | "cleanup"
               | "delivery_reconcile" | "schedule";
interface LoopError {
  phase: LoopPhase;
  message: string;
  errorType?: string;    // error.name，便于区分领域异常与基础设施异常
  subjectId?: string;    // error 上携带的 runId/taskId/deliveryId
}
```

相对设计稿的两点小扩展（都不改语义）：

```text
1. 阶段名增加了 "cleanup"（retryFailedCleanups 也纳入隔离）—— 否则该阶段异常
   仍会中断整个 tick，与 hardening 目标矛盾；
2. capacity / maxPerPass 允许构造参数覆盖（默认仍是 100 / 20），只为测试能在不
   生成 100 条迁移的前提下验证容量行为。
```

通知 pending 行为（实测）：

```text
失败     → 仍留在 pending（at-least-once），Delivery 状态不受影响
重试     → 下一个 pass 按 FIFO 先发最旧的；每 pass 最多尝试 maxPerPass 次
超容量   → 丢弃**最新**那条并计入 droppedNotifications + notificationFailures
```

`Scheduler` / `Worker` / `Task 状态` / Delivery 聚合规则在 Phase B 中未改动
（`git diff --stat` 可核对）。

### Phase C 实现记录（已完成）

没有新增 Command，只扩展现有事实视图：

```text
src/channel/rendering/task.ts       # TaskDependencyFacts + waiting /
                                    # dependencyBlocked / blockingTaskIds /
                                    # blockingChain + Latest failure
                                    # （formatFailure 供 task/delivery 共用）
src/channel/rendering/delivery.ts   # blockingFacts → dependency-blocked 标记、
                                    # Blocking chain、Failure（含 evidence 归属）
src/task/application/dependencyService.ts  # describe().blockingChain（解析成 Task）
src/run/application/taskRunService.ts      # latestFailure + failureTaskId
src/command/handlers/taskRun.ts      # task.show 暴露 impact / latestFailure
src/command/handlers/delivery.ts     # delivery.show|release 传入 blockingFacts
src/delivery/application/reconciler.ts # blocked 通知携带 chain + evidence
src/cli/output.ts / deliveryOutput.ts  # 同样的字段落到 CLI 文本
src/cli/index.ts                     # ai task show 用 impact；ai delivery 服务
                                     # 注入 impacts + runs（Phase C 发现的接线缺口）
```

一个实现细节（避免误导）：`Latest failure` / `Failure` 的 evidence 属于**真正跑过的
那个 Task**。当当前 Task 自己没跑过（dependency-blocked）时，证据来自阻塞链上的
失败祖先，并标注来源 taskId；渲染器与 CLI 都不做任何推断。

实测（CLI + 本地 Postgres）：

```text
ai task show task-phaseC-b
  Runnable: no / Dependency blocked: yes
  Dependencies: ⏳ task-phaseC-x X 迁移 (BLOCKED)
  Blocked by:   task-phaseC-x — BLOCKED
  Blocking chain: task-phaseC-x X 迁移 (BLOCKED) ↓ task-phaseC-b B 页面 (READY)
  Latest failure: task-phaseC-x: verification: npm test (exit 1) / 3 tests failed

ai delivery show dlv-phaseC
  Status: BLOCKED
  Tasks: ✗ task-phaseC-x BLOCKED (optional) / ✗ task-phaseC-b dependency-blocked (blocked by task-phaseC-x)
  Blocking chain: … ↓ …
  Failure: task-phaseC-x: verification: npm test (exit 1)

ai loop --once（Delivery 复位为 IN_PROGRESS 后）
  → deliveryTransitions=1 deliveryNotifications=1
  → 通知卡片同样包含 Tasks / Blocking chain / Failure / (not released)
```

Phase C 未改动：Scheduler、Worker、Loop、Delivery 聚合规则、Task 状态机；未新增
Command / 状态 / 自动 Retry / 自动 Release / 真实消息平台发送。

## 11. 明确不做

```text
❌ 新 Failure / Retry 对象        ❌ 新 TaskStatus（含自动把下游改成 BLOCKED）
❌ Run 状态机修改                 ❌ 自动 Release / Merge / Push / Deploy
❌ Git PR / CI-CD 集成            ❌ Feishu / DingTalk / Slack 实际发送
❌ LLM 推断失败原因               ❌ Scheduler / Worker 重构
❌ Notification Queue 持久化      ❌ auto-unblock / 级联自动恢复策略
```

## 12. 完成标准

```text
Failure → Dependency Impact → Delivery BLOCKED →（人看到 chain + evidence）
        → Retry（新 Workspace）→ Verification → Task DONE
        → 下游 runnable → Delivery 恢复 READY_FOR_RELEASE → 人工 Release
```

并且：单阶段 Loop 异常不中断 tick；通知失败/丢失不改变状态；并发与重试不产生
重复 active Run；Delivery 状态始终是当前 Task 事实的聚合。
