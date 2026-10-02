# 自主化重设计（v0.3 提案）

> 起因：2026-10-01 用真实问题跑了一轮完整链路，暴露出人被迫留在执行循环里：
> 一个「把移动端按钮间距调大」的需求被拆成 3 个任务、每个都要人手动 `运行`、
> 每个都要人 `review.approve`，而真正的验收只有一条仓库级命令。
>
> 本文按四条诉求重新梳理：**任务要不要拆这么细**、**评审能不能交给评审 agent**、
> **验收有没有完整机制**、**ready 之后能不能自动开始**。
> 目标只有一个：**把人从执行循环里挪出去，只留在需求、方案、验收三个点上。**

## 1. 现状（逐条对照，都有代码证据）

### 1.1 任务拆得细、暴露、且每条都要人确认

| 事实 | 证据 |
| --- | --- |
| 一条 requirement = 一个 Task | `DeterministicTaskPlanner.plan()`（`src/specification/application/planner.ts`）按 requirements 逐条产出 plan item |
| Task 从 INBOX 起步 | `PLANNED_TASK_STATUS = "INBOX"`（`specification/application/planning.ts`） |
| 调度器只认 READY | `Scheduler.schedule()` 只 `listTasks({ status: "READY" })`（`scheduler/scheduler.ts`） |
| 没有 INBOX→READY 的自动路径 | 全仓唯一把任务从非 READY 推起来的是人的 `task.run`（`run/application/taskRunService.ts`） |
| 每条都要人审批 | `review.approve` / `review.request_changes` 的 actor 是人（`review/application/reviewService.ts`，角色 reviewer/admin） |

实测 `spec-eaf44ab493`（移动端按钮间距）产出 3 条 requirement：

```text
task-…-0  间距被增大到合理视觉间距      ← 真正的交付物
task-…-1  只作用于移动端，不改桌面端    ← 其实是约束
task-…-2  不同宽度下布局稳定、不重叠    ← 其实是验收标准
```

后两条不是独立交付物，却被机械地变成两个任务，等价于让一个人分三次做同一件事、确认三遍。

### 1.2 评审完全靠人

`ReviewService` 只有两个动作，actor 都是人的 open_id。计划里本来就写了
**Reviewer Agent**（`docs/ai-coding-harness-v0.1.md` §25「v0.2 再增加」），至今没有实现。

### 1.3 验收机制不完善

| 事实 | 证据 |
| --- | --- |
| 验收标准只进 agent 提示词 | `task.acceptance` 仅出现在 `agent/contextBuilder.ts` 的 prompt 文本里 |
| 真正的门是仓库级命令 | `Verifier.run()` 执行 `repository.verificationCommands` |
| 没有命令 = 必然失败 | 空命令时塞一条 `status: failed`（`verification/runner.ts`） |
| 验收标准、验证命令、任务三者无映射 | 没有任何代码把 acceptance 变成可执行检查 |

实测 x-music 那轮 `acceptance` 有 5 条（间距计算值、截图对比、3 种宽度、桌面端一致性、
构建通过），而实际门禁只有一条 `node scripts/check-docs.mjs`——**5 条验收标准一条都没被验证**。

### 1.4 Ready 之后不会自动开始

见 1.1：planning 产出 INBOX，scheduler 只挑 READY，中间没有桥。每跑一条都要人在聊天里
`运行 task-x`。Delivery 也不会自动 release（Phase 12 记录：三次连跑 `releases = 0`）。

## 2. 设计原则

1. **人是需求方和验收方，不是调度器。** 派发、串行/并行、重试由机器决定。
2. **只有三类人工介入**：需求澄清、方案确认、验收确认；再加不可逆动作（push/merge/release）。
3. **可判定的交给机器，且必须留证据。** 机器不猜；判不了就升级给人，而不是默默通过。
4. **人看到的是需求单和交付，不是任务列表。**

## 3. 新对象模型：谁是人看的单位

```text
人看的：       Problem（问题） → Specification（需求单 + 验收契约） → Delivery（交付）
机器内部的：                        Task（工作项） → Run → Evidence
```

**Task 降级为内部工作项**：它仍然存在（并行、依赖、重试的单位），但

- 不再逐条要求人 `运行`；
- 不再逐条要求人 `approve`；
- 默认不在聊天里逐条推送，只有 `查看进度` 才展开。

生命周期提案（现状 → 目标）：

```text
Specification:  DRAFT → READY → PLANNED → SUPERSEDED
                DRAFT → READY → PLANNED → IN_PROGRESS → VERIFIED → ACCEPTED
Task:           INBOX → RUNNING → VERIFYING → REVIEW → DONE / BLOCKED
                INBOX→RUNNING 由系统自动完成；REVIEW 先过评审 agent，人只处理升级
```

## 4. 四条设计

### 4.1 拆分：按「可独立验收的变更」拆，且不再逐条确认

- **规则**：一个 plan item 必须能独立回答「做完怎么证明」。证明不了的两条 → 合并。
  约束和验收标准不是交付物，不许变成任务。
- **实现落点**：
  - derive 的 prompt 契约从「2..4 条 outcome 级 requirement」升级为
    **requirement ↔ acceptance ↔ checks 三方可映射**（每条 requirement 至少对应一条
    acceptance；每条 acceptance 要么有 check，要么显式 `unverifiable`）；
  - 确定性 planner 增加**近重复合并**（同一文件/同一验收标准的 requirement 合并）；
  - plan item 携带 `acceptance[]` 子集与 `checks[]`，Task 直接继承。
- **暴露策略**：聊天默认只报需求单 + 「N 个工作项（内部，已自动开始）」。
  拆分结果不单独找人确认——它随「方案确认」整体看一次。

### 4.2 评审：专门的评审 agent，人只在升级时介入

新增 `ReviewerAgent`（LLM），输入：需求单（requirements + acceptance）、本次 diff、
验证证据、仓库约定；输出**结构化**结论：

```json
{
  "verdict": "approve | request_changes | needs_human",
  "criteria": [{ "index": 1, "status": "met | not_met | unverifiable", "evidence": "..." }],
  "risks": ["..."],
  "notes": "..."
}
```

- **触发**：验证通过 → Task 进 REVIEW → 评审 agent 自动跑 → 给出 verdict。
- **自动通过**：verdict=approve 且所有 acceptance 都 machine-verified 且低风险 → Task 直接
  DONE，不找人。
- **自动返工**：verdict=request_changes → Task 回 READY，带着评审意见重跑（attempts 内）。
- **升级给人**：`needs_human`、存在 `unverifiable`、风险高（迁移/配置/生产路径/secrets/
  大 diff）、或连续失败 → 带着评审意见和证据包找人。
- **留痕**：`TaskReview` 从自由文本升级为结构化记录，带 `actorKind: agent | human`、
  `verdict`、`evidence`。

### 4.3 验收：把 acceptance 变成可执行的检查

每条验收标准必须落在两处之一：

| 类型 | 含义 | 谁来确认 |
| --- | --- | --- |
| `check` | 映射到一条可执行检查（仓库验证命令，或任务级断言） | 机器 |
| `unverifiable` | 显式承认机器判不了（如「看起来更舒服」） | 人（验收时） |

- **证据包**（每个 Task 一份，结构化）：diff stat、跑过的命令与退出码、截断输出、
  每条 acceptance → 哪条 check（或为什么 unverifiable）。现有
  `run.result.targets[].checks` 已是雏形，补齐 acceptance 映射即可。
- **分层门禁**：
  1. 仓库 `verificationCommands` —— 回归底线（还能不能跑）；
  2. 任务级 `checks` —— 本次变更是否成立；
  3. 元检查 —— 有行为变更却没有测试变更时必须给出理由（策略开关）。
- 价值：所谓「验收确认」变成**人看证据包**，而不是凭感觉点通过；也顺带把
  「5 条验收标准、1 条命令」这种落差暴露出来。

### 4.4 Ready 即自动开始

- planning 产出即**可执行**，scheduler 立刻按 DAG 派发，**不再需要人 `运行`**。
- 授权来源是「方案确认」这一次（见 §5），之后全自动跑到验收。
- 保留人工逃生口：暂停、停止、重跑、打回（`task.run` 从「启动」降级为「重跑」）。
- **前置条件**（否则自动开始会放大损失）：并发上限、Run 超时、预算熔断——
  即 backlog #16/#17，必须与本节同批落地。

## 5. 人工介入清单（唯一需要人的地方）

| 环节 | 为什么必须是人 | 能不能省 |
| --- | --- | --- |
| 需求不明确（澄清问答） | 只有人能澄清意图 | 不能；已由 Problem Confirmation Loop 收敛 |
| 方案确认（需求单 + 验收契约 + 拆分） | 不确定的内容需要人拍板 | **一次**；低风险 + 高置信度时可由策略自动通过 |
| 验收确认 | `unverifiable` 的标准、高风险变更 | 只在评审 agent 判不了时 |
| 不可逆动作（push / merge / release / deploy） | 影响生产 | 策略控制；可先只做 push，合并/发布留给人 |

**其余全部自动**：建任务、排期、串行/并行、运行、失败重试、返工迭代、逐任务通过。

## 6. 目标流转

```text
Problem ──confirm──▶ Specification(DRAFT)
                          │ derive
                          ▼
                 需求单 + 验收契约 + 拆分
                          │
                    [方案确认]  ← 唯一的一次「开始」授权
                          │
                          ▼
              planning（自动）→ 工作项 READY
                          │
                          ▼
        Scheduler/Loop（自动，按 DAG、并发上限、预算）
                          │
                          ▼
        Run → Verification（仓库命令 + 任务级 checks）
                          │
                          ▼
              ReviewerAgent（自动，结构化 verdict）
                   ├── approve         → Task DONE（无人）
                   ├── request_changes → Task READY（自动返工）
                   └── needs_human     → 升级（带证据包）
                          │
                          ▼
              Delivery 聚合 → [验收确认] → release
```

## 7. 代码落点

| 模块 | 改动 |
| --- | --- |
| `specification/application/planner.ts` | 合并规则；plan item 携带 acceptance 子集与 checks |
| `server/specificationBootstrap.ts` | derive 契约升级为 requirement↔acceptance↔checks |
| `specification/application/planning.ts` | 产出可执行状态；Task 继承 acceptance/checks |
| `scheduler/` + `loop/` | 自动派发；INBOX 语义调整；预算/超时前置 |
| 新增 `reviewer/`（application + domain） | 评审 agent、verdict、证据包、升级策略 |
| `worker/worker.ts` | 验证后自动评审；按 verdict 决定 DONE / 返工 / 升级 |
| `domain/task.ts` | `TaskReview` 结构化（actorKind / verdict / evidence） |
| `command/` | 新增 `spec.accept_plan`、`delivery.accept`；`task.run` 降级为重跑 |
| `channel/rendering/*` | 方案确认卡、证据包卡、进度卡替代逐条确认 |
| 策略层（新增或并入 config） | 升级条件、风险分级、预算、并发 |

## 8. 迁移与兼容

- **不破坏 Phase 12 frozen 证据**：验收矩阵、Gate、`releases = 0` 等口径不变。
- **分阶段放权**（每步独立开关，可单独回滚）：
  1. **自动开始**（收益最大、风险可控，先做）；
  2. **可执行验收**（先只产出证据包 + 元检查，不改门禁）；
  3. **评审 agent shadow**（只记录 verdict，不参与决策）；
  4. **评审 agent 决策**（approve 自动 DONE，其余升级）；
  5. **交付级验收**（Delivery 一次确认）。
- 现网先跑 1+2+3，观察若干轮 verdict 与人工判断的一致率，再开 4。

## 9. 任务拆分提案

```text
TASK-1219  自动开始      planning→可执行；scheduler 自动派发；task.run 降级为重跑
TASK-1220  可执行验收    acceptance→checks 映射、证据包、元检查（先不改门禁）
TASK-1221  评审 agent    结构化 verdict + 证据 + shadow 模式
TASK-1222  升级策略      何时找人（风险/不确定/unverifiable）；方案确认一次
TASK-1223  交付验收      Delivery 级证据聚合 + 一次人确认
TASK-1224  拆分收敛      planner 合并规则；requirement↔acceptance↔checks 契约
```

建议顺序：**1219 → 1220 → 1221（shadow）→ 1222 → 1224 → 1223**。
1224 也可以提前（它直接决定任务数量），但它改的是 derive 契约，和 1219 一起做最省事。

## 10. 风险与取舍

| 风险 | 应对 |
| --- | --- |
| 自动开始放大成本（失败重试 × 3） | 与 backlog #16/#17（预算、超时）同批落地，否则不做 4.4 |
| 评审 agent 误判放行坏改动 | 先 shadow；高风险永远升级；保留人工打回 |
| 验收标准写不出可执行检查 → 退化成「人看着办」 | 元检查强制显式 `unverifiable`，并统计比例 |
| 拆粗了单次改动过大、评审无从下手 | 以「可独立验收」为上界，不是「越细越好」 |
| 自动通过后无人知晓改了什么 | 每次自动 DONE 推送一张证据包卡片（不要求回复） |
